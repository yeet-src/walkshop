/* From terms to field programs.
 *
 * A term is the compiler-neutral middle: both front-ends (the select
 * strings in select.js, the GraphQL in gql/compile.js) parse into
 * terms, and this module turns a term into ops with the root's
 * registers and BTF. A term is one of:
 *
 *   { kind: "path",  base, members, as?, size? }        a struct member, by name
 *   { kind: "raw",   reg, offset, len, as, needs? }     bytes at a register (payload, at)
 *   { kind: "reg",   reg, as?, size? }                  the register's value itself
 *   { kind: "arith", sign: "+" | "-", a, b }            two paths, or a path and an int
 *   { kind: "int",   value }                            only as an arithmetic operand
 *   { kind: "mask",  term, and?, shr? }                 term & and >> shr, as a value
 *   { kind: "gate",  cond: { term, op, imm }, term }    emit term only when cond holds
 *
 * `root` is a descriptor from roots.js: `bases[name] = { reg, struct }`.
 * Pure given `btf`. */

import { ENTRY_CAP, MAX_FIELDS, MAX_READ, MAX_STEP, REG, WOP, op } from "./ops.js";
import { KINDS, resolve } from "./resolve.js";

export class CompileError extends Error {
  constructor(entry, message) {
    super(entry != null ? `\`${entry}\`: ${message}` : message);
    this.entry = entry;
  }
}

const SIZE_OF = { int: 4, uint: 4, hex: 8, ptr: 8, bool: 1, ip4: 4, ip6: 16, port: 2, be: 2, mac: 6 };

export function checkKind(kind) {
  const k = kind.startsWith("json:") ? "json" : kind;
  if (!KINDS.has(k) || k === "enum") throw new Error(`unknown kind \`${kind}\`; one of ${[...KINDS].filter((x) => x !== "enum").join(", ")}, json:<field>`);
}

function baseOf(root, name) {
  const base = root.bases[name];
  if (!base) throw new Error(`unknown base \`${name}\`; the ${root.name} root has ${Object.keys(root.bases).join(", ")}`);
  if (!base.struct) throw new Error(`\`${name}\` has no struct; read it with at(offset, len, kind)`);
  return base;
}

/* Ops that leave the cursor at the member (every hop but the terminal's read). */
function navigate(reg, hops) {
  const ops = [op(WOP.BASE, reg)];
  for (const h of hops) {
    if (h.at) ops.push(op(WOP.OFF, h.at));
    if (h.op === "deref") ops.push(op(WOP.DEREF));
  }
  return ops;
}

/* Apply a `(kind, size)` override to an inferred decode. */
function override(r, as, size, what) {
  if (!as) return r.decode;
  const kind = as.startsWith("json:") ? "json" : as;
  checkKind(as);
  const n = size ?? (kind === "str" ? ENTRY_CAP : kind === "text" || kind === "auto" || kind === "bytes" || kind === "json" ? Math.min(r.decode.size ?? 64, MAX_READ) : (SIZE_OF[kind] ?? r.decode.size));
  if (size != null && (size < 1 || size > MAX_READ)) throw new Error(`size 1–${MAX_READ}`);
  const decode = { kind, size: n, ...(kind === "json" ? { field: as.slice(5) } : {}), ...(kind === "port" ? { kind: "be", size: 2 } : {}) };
  if (r.bitfield && !["uint", "int", "hex", "bool"].includes(kind)) throw new Error(`\`${what}\` is a bitfield; read it as uint, int, hex or bool`);
  if (r.bitfield) decode.bitfield = r.bitfield;
  return decode;
}

/* A path read out as bytes: `{ ops, decode }`. */
async function readPath(btf, root, term) {
  const base = baseOf(root, term.base);
  const r = await resolve(btf, base.struct, term.members);
  const ops = navigate(base.reg, r.hops);
  const decode = override(r, term.as, term.size, `${term.base}.${term.members.join(".")}`);
  if (decode.kind === "str") ops.push(op(WOP.STR));
  else ops.push(op(WOP.READ, Math.min(decode.size, MAX_READ)));
  if (base.needs) decode.needs = base.needs;
  return { ops, decode, resolved: r };
}

/* A path loaded INTO the cursor, for arithmetic or a comparison: `{ ops, size, be }`. */
async function valuePath(btf, root, term) {
  if (term.kind === "reg") return { ops: [op(WOP.BASE, term.reg)], size: term.size ?? 8, be: false };
  if (term.kind !== "path") throw new Error("arithmetic and comparisons want a struct member");
  const base = baseOf(root, term.base);
  const r = await resolve(btf, base.struct, term.members);
  const last = r.hops[r.hops.length - 1];
  const name = `${term.base}.${term.members.join(".")}`;
  if (!last || last.op !== "load") throw new Error(`\`${name}\` is not a scalar; arithmetic needs an integer or a pointer`);
  const ops = navigate(base.reg, r.hops);
  const width = last.width ?? 8;
  ops.push(width === 8 ? op(WOP.DEREF) : op(WOP.LOADN, width));
  if (r.bitfield) {
    /* A bitfield loads its storage unit; shift and mask it down. */
    ops.push(op(WOP.SHR, r.bitfield.bit_offset));
    ops.push(op(WOP.AND, (2 ** r.bitfield.bit_size - 1) >>> 0));
  }
  return { ops, size: width, be: r.decode.kind === "be" || r.decode.kind === "ip4", resolved: r };
}

function rawOps(term) {
  if (term.len < 1 || term.len > MAX_READ) throw new Error(`len 1–${MAX_READ}`);
  checkKind(term.as);
  const ops = [op(WOP.BASE, term.reg)];
  if (term.offset) ops.push(op(WOP.OFF, term.offset));
  const kind = term.as.startsWith("json:") ? "json" : term.as;
  /* On a hook that has the skb, a window is read through it, so the
   * page frags count; elsewhere a probe read of the linear head. */
  if (term.skb) ops.push(op(WOP.SKB, term.len));
  else if (kind === "str") ops.push(op(WOP.STR));
  else ops.push(op(WOP.READ, term.len));
  const decode = { kind, size: term.len, ...(kind === "json" ? { field: term.as.slice(5) } : {}) };
  if (term.reg === REG.PAYLOAD) decode.payload = term.offset;
  if (term.needs) decode.needs = term.needs;
  return { ops, decode };
}

function regOps(term) {
  const kind = term.as ?? "ptr";
  checkKind(kind);
  const size = term.size ?? SIZE_OF[kind] ?? 8;
  return { ops: [op(WOP.BASE, term.reg), op(WOP.VAL, Math.min(size, 8))], decode: { kind, size: Math.min(size, 8) } };
}

const bswap = (v, size) =>
  size === 2 ? (((v & 0xff) << 8) | ((v >> 8) & 0xff)) : size === 4 ? ((((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0) : v >>> 0;

const CMP = { eq: WOP.EQ, lt: WOP.LT, gt: WOP.GT };

/* Ops that leave 0/1 in the cursor for `term <op> imm`. `ne` is `eq`
 * with the skip inverted by the caller. A big-endian field compares
 * against the byte-swapped immediate, so a query says 443. */
async function condOps(btf, root, cond) {
  const v = await valuePath(btf, root, cond.term);
  let imm = cond.imm >>> 0;
  if (v.be) imm = bswap(imm, v.size);
  const code = CMP[cond.op === "ne" ? "eq" : cond.op];
  if (!code) throw new Error(`unknown comparison \`${cond.op}\`; one of eq, ne, lt, gt`);
  return { ops: [...v.ops, op(code, imm)], invert: cond.op === "ne" };
}

async function arithOps(btf, root, expr) {
  const { sign, a, b } = expr;
  if (a.kind === "int" && b.kind === "int") throw new Error("arithmetic needs a field");
  if (a.kind === "raw" || b.kind === "raw") throw new Error("payload() is bytes, not a number");
  if (b.kind === "int") {
    const va = await valuePath(btf, root, a);
    if (b.value) va.ops.push(op(sign === "+" ? WOP.OFF : WOP.BACK, b.value));
    va.ops.push(op(WOP.VAL, va.size));
    return { ops: va.ops, decode: { kind: "uint", size: va.size } };
  }
  if (a.kind === "int") {
    if (sign === "-") throw new Error("`N - field` is not supported; write `field - N`");
    const vb = await valuePath(btf, root, b);
    if (a.value) vb.ops.push(op(WOP.OFF, a.value));
    vb.ops.push(op(WOP.VAL, vb.size));
    return { ops: vb.ops, decode: { kind: "uint", size: vb.size } };
  }
  const va = await valuePath(btf, root, a);
  const vb = await valuePath(btf, root, b);
  const size = Math.max(va.size, vb.size);
  /* b first into scratch 0, then a, then combine — every path is register-rooted, so order is free. */
  const ops = [...vb.ops, op(WOP.STORE, 0), ...va.ops, op(sign === "+" ? WOP.ADD : WOP.SUB, 0), op(WOP.VAL, size)];
  return { ops, decode: { kind: "uint", size } };
}

async function maskOps(btf, root, expr) {
  const v = await valuePath(btf, root, expr.term);
  const ops = [...v.ops];
  if (expr.shr) ops.push(op(WOP.SHR, expr.shr));
  if (expr.and != null) ops.push(op(WOP.AND, expr.and >>> 0));
  ops.push(op(WOP.VAL, v.size));
  return { ops, decode: { kind: "uint", size: v.size } };
}

/** A term → `{ ops, decode }`. */
export async function termOps(btf, root, term) {
  switch (term.kind) {
    case "path":
      return readPath(btf, root, term);
    case "raw":
      return rawOps(term);
    case "reg":
      return regOps(term);
    case "arith":
      return arithOps(btf, root, term);
    case "mask":
      return maskOps(btf, root, term);
    case "gate": {
      const c = await condOps(btf, root, term.cond);
      const t = await termOps(btf, root, term.term);
      /* The condition leaves 0/1; a failed test skips the whole term,
       * so nothing is written and the column is null for that row. */
      return { ops: [...c.ops, op(c.invert ? WOP.SKIPNZ : WOP.SKIPZ, t.ops.length), ...t.ops], decode: t.decode };
    }
    case "int":
      throw new Error("a number alone is not a field");
    default:
      throw new Error(`unknown term kind \`${term.kind}\``);
  }
}

/* Split a field's ops across pre/body. The cursor is the only state the
 * VM carries between the sections, so a boundary is valid where no
 * forward skip reaches past it and no scratch value is live across it. */
export function split(ops, name) {
  if (ops.length <= MAX_STEP) return [[], ops];
  if (ops.length > 2 * MAX_STEP) throw new Error(`${ops.length} ops — the VM runs ${2 * MAX_STEP} per field; chase fewer pointers`);
  const barred = new Set();
  for (let i = 0; i < ops.length; i++) {
    const { code, arg } = ops[i];
    let end = -1;
    if (code === WOP.SKIPZ || code === WOP.SKIPNZ) end = i + arg;
    if (code === WOP.STORE) {
      for (let j = i + 1; j < ops.length && !(ops[j].code === WOP.STORE && ops[j].arg === arg); j++) {
        if ((ops[j].code === WOP.LOAD || ops[j].code === WOP.ADD || ops[j].code === WOP.SUB) && ops[j].arg === arg) end = j;
      }
    }
    for (let k = i + 1; k <= end; k++) barred.add(k);
  }
  for (let k = Math.min(MAX_STEP, ops.length - 1); k >= ops.length - MAX_STEP; k--) {
    if (!barred.has(k)) return [ops.slice(0, k), ops.slice(k)];
  }
  throw new Error(`no split point in ${ops.length} ops for \`${name}\``);
}

/**
 * Compile named terms into field programs for one root:
 * `[{ name, source, pre, body, nextOff, maxIters, decode, ops }]`.
 * `entries` is `[{ name, term, source? }]`. Throws a CompileError
 * naming the entry.
 */
export async function compileFields(btf, root, entries) {
  if (!entries.length) throw new CompileError(null, "select at least one field");
  if (entries.length > MAX_FIELDS) throw new CompileError(null, `at most ${MAX_FIELDS} fields per root`);
  const fields = [];
  const names = new Set();
  for (const entry of entries) {
    const source = entry.source ?? entry.name;
    try {
      if (!entry.name) throw new Error("name this column");
      if (names.has(entry.name)) throw new Error(`\`${entry.name}\` is selected twice`);
      names.add(entry.name);
      const { ops, decode } = await termOps(btf, root, entry.term);
      const [pre, body] = split(ops, entry.name);
      fields.push({ name: entry.name, source, pre, body, nextOff: 0, maxIters: 1, decode, ops });
    } catch (e) {
      throw new CompileError(source, String(e?.message ?? e));
    }
  }
  return fields;
}
