/* From a parsed query to a plan per root: which columns are free (the
 * event's prefix), which are VM terms (compiled through BTF later),
 * what the kernel filters on, and how the rows shape back into the
 * selection's nesting.
 *
 * Pure: no BTF here. A plan's `entries` are terms for emit.js; the
 * only names checked are the ones the roots table knows (bases,
 * aliases, prefix columns, arguments, directives). A member name
 * inside a base is BTF's to judge.
 *
 *   {
 *     tcp(ports: [80], data: true, limit: 20) {
 *       hook comm daddr dport                 # prefix: free
 *       cwnd srtt                             # aliases: VM
 *       tcp { rx_opt { ts_recent } }          # base, nested members: VM
 *       sock { sk_dst_cache { dev { name } } }
 *       ip { ttl }  tcphdr { window syn }
 *       inflight: sndNxt @minus(field: "sndUna")
 *       https: tcphdr { dest @when(eq: 443) }
 *       req: payload(offset: 0, len: 64, kind: text)
 *       raw: sock { at(offset: 0, len: 16, kind: hex) }
 *     }
 *   }
 */

import { PREFIX } from "../vm/decode.js";
import { MAX_FIELDS, MAX_READ } from "../vm/ops.js";
import { KINDS } from "../vm/resolve.js";
import { ROOTS, splitPath } from "../roots.js";
import { fail } from "./lex.js";
import { parse } from "./parse.js";
import { buildPipeline } from "./pipeline.js";

export const META = ["struct", "roots", "__schema"];

const MAX_MS = 15_000;
const MAX_LIMIT = 1000;

const ARGS = {
  ports: (v, l) => {
    const list = Array.isArray(v) ? v : [v];
    if (!list.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) fail(l, "ports: a list of port numbers");
    return list;
  },
  data: (v, l) => (typeof v === "boolean" ? v : fail(l, "data: true or false")),
  limit: (v, l) => (Number.isInteger(v) && v > 0 ? Math.min(v, MAX_LIMIT) : fail(l, "limit: a positive integer")),
  ms: (v, l) => (Number.isInteger(v) && v > 0 ? Math.min(v, MAX_MS) : fail(l, "ms: a positive integer")),
  every: (v, l) => (Number.isInteger(v) && v >= 0 ? v : fail(l, "every: milliseconds")),
  iface: (v, l) => {
    const list = Array.isArray(v) ? v : [v];
    if (!list.every((x) => typeof x === "string" || Number.isInteger(x))) fail(l, "iface: a name or index, or a list");
    return list;
  },
  proto: (v, l) => (v === "tcp" || v === "udp" ? v : fail(l, "proto: tcp or udp")),
  pid: (v, l) => (Number.isInteger(v) && v > 0 ? v : fail(l, "pid: a process id")),
  binary: (v, l) => (typeof v === "string" ? v : fail(l, "binary: a path")),
};

function rootArgs(root, args, line) {
  const out = { limit: 50, ms: 2000, every: 0, ports: [], data: false };
  for (const [k, v] of Object.entries(args)) {
    if (!(k in root.args)) fail(line, `${root.name} takes no argument \`${k}\`; it takes ${Object.keys(root.args).join(", ")}`);
    out[k] = ARGS[k](v, line);
  }
  if (root.name === "xdp" && !out.iface) fail(line, "xdp needs iface: the interface to attach to");
  return out;
}

const kindArg = (a, line, fallback) => {
  const k = a.kind ?? fallback;
  if (typeof k !== "string" || !(KINDS.has(k.startsWith("json:") ? "json" : k)) || k === "enum") fail(line, `kind: one of ${[...KINDS].filter((x) => x !== "enum").join(", ")}, json:<field>`);
  return k;
};

/* A window's default length: most of a packet for text, a screen of
 * dump for bytes. The cap is MAX_READ either way. */
const DEFAULT_LEN = { text: 1024, auto: 1024, str: 1024, json: 1024, bytes: 256 };

const windowArgs = (a, line, fallback) => {
  const offset = a.offset ?? 0;
  const kind0 = typeof a.kind === "string" ? (a.kind.startsWith("json:") ? "json" : a.kind) : fallback;
  const len = a.len ?? DEFAULT_LEN[kind0] ?? 256;
  if (!Number.isInteger(offset) || offset < 0) fail(line, "offset: a non-negative integer");
  if (!Number.isInteger(len) || len < 1 || len > MAX_READ) fail(line, `len: 1–${MAX_READ}`);
  return { offset, len, kind: kindArg(a, line, fallback) };
};

/* A `field: "…"` reference in a directive: an alias, a dotted path from
 * a base, or a sibling member in the current base. */
function fieldRef(root, ref, base, members, line) {
  if (typeof ref !== "string") fail(line, 'field: "a sibling member, an alias, or base.member"');
  if (ref.includes(".") || !base || root.aliases[ref]) {
    try {
      const { base: b, members: m } = splitPath(root, ref);
      return { kind: "path", base: b, members: m };
    } catch (e) {
      fail(line, String(e.message));
    }
  }
  return { kind: "path", base, members: [...members, ref] };
}

const CMPS = ["eq", "ne", "lt", "gt"];

/* Wrap a leaf's term in its directives. */
function applyDirectives(root, term, leaf, base, members) {
  let out = term;
  for (const d of leaf.directives) {
    const l = d.line;
    if (d.name === "plus" || d.name === "minus") {
      if (out.kind !== "path") fail(l, `@${d.name} applies to a struct member`);
      out = { kind: "arith", sign: d.name === "plus" ? "+" : "-", a: out, b: fieldRef(root, d.args.field, base, members, l) };
    } else if (d.name === "and" || d.name === "shr") {
      const inner = out.kind === "mask" ? out : { kind: "mask", term: out };
      if (inner.term.kind !== "path") fail(l, `@${d.name} applies to a struct member`);
      const v = d.args[d.name === "and" ? "mask" : "bits"];
      if (!Number.isInteger(v) || v < 0) fail(l, d.name === "and" ? "@and(mask: Int)" : "@shr(bits: Int)");
      out = { ...inner, [d.name]: v };
    } else if (d.name === "when") {
      const op = CMPS.find((c) => c in d.args);
      if (!op) fail(l, `@when wants one of ${CMPS.map((c) => `${c}: Int`).join(", ")}`);
      if (!Number.isInteger(d.args[op])) fail(l, `@when(${op}:) wants an integer`);
      const condTerm = d.args.field !== undefined ? fieldRef(root, d.args.field, base, members, l) : out.kind === "path" ? out : fail(l, "@when on a computed value needs field: the member to test");
      out = { kind: "gate", cond: { term: condTerm, op, imm: d.args[op] }, term: out };
    } else {
      fail(l, `unknown directive @${d.name}; have @when @plus @minus @and @shr`);
    }
  }
  return out;
}

/* A @when on a prefix column is a host-side filter. */
function hostFilter(leaf, column) {
  const filters = [];
  for (const d of leaf.directives) {
    if (d.name !== "when") fail(d.line, `@${d.name} does not apply to \`${leaf.name}\`, which is read from the event, not the VM`);
    const op = CMPS.find((c) => c in d.args);
    if (!op) fail(d.line, `@when wants one of ${CMPS.join(", ")}`);
    filters.push({ column, op, value: d.args[op] });
  }
  return filters;
}

function planRoot(sel) {
  const root = ROOTS[sel.name];
  const args = rootArgs(root, sel.args, sel.line);
  if (!sel.selections?.length) fail(sel.line, `${root.name} needs a selection set { … }`);
  if (sel.directives.length) fail(sel.line, "directives go on leaves, not on a root");

  const ctx = { entries: [], columns: [], filters: [], names: new Set() };
  const unique = (name, line) => {
    if (ctx.names.has(name)) fail(line, `\`${name}\` is selected twice; alias one of them`);
    ctx.names.add(name);
    return name;
  };

  const walk = (sels, base, members, prefix) => {
    const layout = {};
    for (const leaf of sels) {
      const key = leaf.alias ?? leaf.name;
      const l = leaf.line;
      const name = unique([...prefix, key].join("."), l);
      if (!base) {
        if (leaf.name === "payload") {
          if (leaf.selections) fail(l, "payload() is bytes; no selection set");
          /* A payload defaults to `auto`: the row decides text or dump. */
          const w = windowArgs(leaf.args, l, "auto");
          const term = { kind: "raw", reg: root.payload, offset: w.offset, len: w.len, as: w.kind, ...(root.skb ? { skb: true } : {}) };
          ctx.entries.push({ name, term: applyDirectives(root, term, leaf, null, []), source: `${key}: payload(${w.offset}, ${w.len}, ${w.kind})` });
          layout[key] = { kind: "vm", name };
        } else if (leaf.name in PREFIX) {
          if (leaf.selections) fail(l, `\`${leaf.name}\` is a scalar`);
          ctx.columns.push(leaf.name);
          ctx.filters.push(...hostFilter(leaf, leaf.name));
          layout[key] = { kind: "prefix", name: leaf.name };
        } else if (leaf.name in root.aliases) {
          if (leaf.selections) fail(l, `\`${leaf.name}\` is a scalar`);
          const { base: b, members: m } = splitPath(root, leaf.name);
          const term = { kind: "path", base: b, members: m, as: leaf.args.kind ? kindArg(leaf.args, l) : null, size: leaf.args.size ?? null };
          ctx.entries.push({ name, term: applyDirectives(root, term, leaf, b, m.slice(0, -1)), source: `${key}: ${leaf.name}` });
          layout[key] = { kind: "vm", name };
        } else if (leaf.name in root.bases) {
          if (!leaf.selections?.length) fail(l, `\`${leaf.name}\` is a struct${root.bases[leaf.name].struct ? ` (${root.bases[leaf.name].struct})` : ""}; select its members { … }, or at(offset:, len:, kind:)`);
          if (leaf.directives.length) fail(l, "directives go on leaves, not on a base");
          layout[key] = { kind: "object", fields: walk(leaf.selections, leaf.name, [], [...prefix, key]) };
        } else {
          const have = [...Object.keys(root.bases), ...Object.keys(root.aliases), "payload", ...Object.keys(PREFIX)];
          fail(l, `\`${leaf.name}\` is not on ${root.name}; it has ${have.join(", ")}`);
        }
        continue;
      }
      /* inside a base */
      const b = root.bases[base];
      if (leaf.name === "at") {
        const w = windowArgs(leaf.args, l, "bytes");
        const term = { kind: "raw", reg: b.reg, offset: w.offset, len: w.len, as: w.kind, ...(b.needs ? { needs: b.needs } : {}) };
        if (members.length) fail(l, "at() reads from the base's own address; put it directly under the base");
        ctx.entries.push({ name, term: applyDirectives(root, term, leaf, base, members), source: `${name}: ${base}.at(${w.offset}, ${w.len}, ${w.kind})` });
        layout[key] = { kind: "vm", name };
      } else if (leaf.name === "self") {
        if (members.length) fail(l, "self is the base's own address; put it directly under the base");
        const term = { kind: "reg", reg: b.reg, as: leaf.args.kind ? kindArg(leaf.args, l) : "ptr" };
        ctx.entries.push({ name, term, source: `${name}: ${base}()` });
        layout[key] = { kind: "vm", name };
      } else if (leaf.selections) {
        if (leaf.directives.length) fail(l, "directives go on leaves, not on a struct");
        if (!b.struct) fail(l, `\`${base}\` has no BTF; read it with at(offset:, len:, kind:)`);
        layout[key] = { kind: "object", fields: walk(leaf.selections, base, [...members, leaf.name], [...prefix, key]) };
      } else {
        if (!b.struct) fail(l, `\`${base}\` has no BTF; read it with at(offset:, len:, kind:)`);
        const term = { kind: "path", base, members: [...members, leaf.name], as: leaf.args.kind ? kindArg(leaf.args, l) : null, size: leaf.args.size ?? null };
        ctx.entries.push({ name, term: applyDirectives(root, term, leaf, base, members), source: `${name}: ${base}.${[...members, leaf.name].join(".")}` });
        layout[key] = { kind: "vm", name };
      }
    }
    return layout;
  };

  const layout = walk(sel.selections, null, [], []);
  if (ctx.entries.length > MAX_FIELDS) fail(sel.line, `${ctx.entries.length} VM fields on ${root.name}; the VM runs ${MAX_FIELDS} per root (prefix columns are free)`);
  return { kind: "root", key: sel.alias ?? sel.name, root: root.name, args, entries: ctx.entries, columns: ctx.columns, filters: ctx.filters, layout, line: sel.line };
}

function planMeta(sel) {
  if (sel.name === "struct") {
    if (typeof sel.args.name !== "string") fail(sel.line, 'struct(name: "tcp_sock")');
    return { kind: "struct", key: sel.alias ?? sel.name, name: sel.args.name, line: sel.line };
  }
  return { kind: sel.name, key: sel.alias ?? sel.name, line: sel.line };
}

/**
 * Plan a query: `{ roots: [plan], meta: [plan] }`. Throws a QueryError
 * with a line.
 */
export function plan(text) {
  const sels = parse(text);
  const roots = [];
  const meta = [];
  for (const sel of sels) {
    if (ROOTS[sel.name]) roots.push(planRoot(sel));
    else if (META.includes(sel.name)) meta.push(planMeta(sel));
    else fail(sel.line, `unknown root \`${sel.name}\`; the roots are ${Object.keys(ROOTS).join(", ")}, and ${META.join(", ")}`);
  }
  /* The tail, checked now so a syntax error has a line; built again per run. */
  const pipeline = buildPipeline(sels.stages);
  return { roots, meta, pipeline, stages: sels.stages ?? [] };
}

/* Whether a row passes the host-side filters. */
export function passes(row, filters) {
  for (const f of filters) {
    const v = row[f.column];
    const w = f.value;
    const ok = f.op === "eq" ? v == w : f.op === "ne" ? v != w : f.op === "lt" ? v < w : v > w; // eslint-disable-line eqeqeq
    if (!ok) return false;
  }
  return true;
}
