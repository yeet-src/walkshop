"use yeet";

/* The query, end to end: plan it, compile each root's terms through
 * this kernel's BTF, run every root at once, shape the rows back into
 * the selection. Runs in the isolate; the HTTP route and the page
 * both call it.
 */

import btf from "yeet:btf";

import { plan, passes } from "./gql/plan.js";
import { DOCS, SDL } from "./gql/schema.js";
import { shapeRows } from "./gql/shape.js";
import { capture, status } from "./probes/registry.js";
import { ROOTS } from "./roots.js";
import { compileFields } from "./vm/emit.js";
import { listing } from "./vm/ops.js";
import { describe } from "./vm/resolve.js";

const error = (message, line = null, path = null) => ({ message, ...(line != null ? { line } : {}), ...(path ? { path } : {}) });

/** Compile one planned root to its fields; `{ fields }` or `{ error }`. */
export async function compileRoot(p) {
  try {
    const fields = p.entries.length ? await compileFields(btf, ROOTS[p.root], p.entries) : [];
    return { fields };
  } catch (e) {
    return { error: error(String(e?.message ?? e), p.line, [p.key]) };
  }
}

async function runMeta(m) {
  if (m.kind === "__schema") return SDL;
  if (m.kind === "roots") {
    return Object.values(ROOTS).map((r) => ({
      name: r.name,
      object: r.object,
      hook: r.hook,
      args: Object.entries(r.args).map(([name, doc]) => ({ name, doc })),
      bases: Object.entries(r.bases).map(([name, b]) => ({ name, struct: b.struct, reg: b.reg, doc: b.doc ?? null })),
      aliases: Object.entries(r.aliases).map(([name, path]) => ({ name, path })),
    }));
  }
  if (m.kind === "struct") return describe(btf, m.name);
  throw new Error(`unknown meta root ${m.kind}`);
}

/**
 * Execute a query text: `{ data, errors? }`. A root with a compile
 * error is reported and the others still run. `onRow(key, shaped)`
 * sees rows as they land, for a stream. With `forever`, the roots'
 * `limit` and `ms` are ignored and only `stop` (a stopToken) ends the
 * captures; the data then holds the last rows of each root.
 */
export async function execute(text, { onRow, stop, forever = false } = {}) {
  let planned;
  try {
    planned = plan(text);
  } catch (e) {
    return { data: null, errors: [error(String(e?.message ?? e), e?.line ?? 1)] };
  }
  const data = {};
  const errors = [];
  /* One pipeline per execute: its context is shared by every root's rows. */
  const pipe = planned.pipeline?.create() ?? null;
  let pipeErrors = 0;
  const through = (key, shaped) => {
    if (!pipe) return shaped;
    try {
      return pipe(shaped, key);
    } catch (e) {
      if (pipeErrors++ === 0) errors.push(error(`transform: ${String(e?.message ?? e)}`, planned.stages[0]?.line ?? 1, [key]));
      return null;
    }
  };

  const jobs = [];
  for (const m of planned.meta) {
    jobs.push(
      runMeta(m)
        .then((v) => (data[m.key] = v))
        .catch((e) => errors.push(error(String(e?.message ?? e), m.line, [m.key]))),
    );
  }
  for (const p of planned.roots) {
    jobs.push(
      (async () => {
        const c = await compileRoot(p);
        if (c.error) {
          errors.push(c.error);
          data[p.key] = null;
          return;
        }
        if (!c.fields.length && !p.columns.length) {
          errors.push(error("select something", p.line, [p.key]));
          data[p.key] = null;
          return;
        }
        /* A root with only prefix columns still needs one VM field to
         * arm the slot; a register value is the cheapest. */
        const fields = c.fields.length ? c.fields : await compileFields(btf, ROOTS[p.root], [{ name: "__arm", term: { kind: "reg", reg: 7 } }]);
        try {
          const args = forever ? { ...p.args, limit: Infinity, ms: Infinity } : p.args;
          const rows = await capture(
            p.root,
            fields,
            args,
            onRow
              ? (row) => {
                  if (!passes(row, p.filters)) return;
                  const shaped = through(p.key, shapeRows([row], p.layout)[0]);
                  if (shaped) onRow(p.key, shaped, row);
                }
              : undefined,
            stop,
          );
          data[p.key] = shapeRows(rows.filter((r) => passes(r, p.filters)), p.layout)
            .map((shaped) => (onRow ? shaped : through(p.key, shaped)))
            .filter(Boolean);
        } catch (e) {
          errors.push(error(String(e?.message ?? e), p.line, [p.key]));
          data[p.key] = null;
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return errors.length ? { data, errors } : { data };
}

/** The ops a query would run, without running: per root, per field. */
export async function explain(text) {
  let planned;
  try {
    planned = plan(text);
  } catch (e) {
    return { errors: [error(String(e?.message ?? e), e?.line ?? 1)] };
  }
  const out = [];
  for (const p of planned.roots) {
    const c = await compileRoot(p);
    out.push({
      root: p.root,
      key: p.key,
      args: p.args,
      columns: p.columns,
      filters: p.filters,
      ...(c.error ? { error: c.error } : { fields: c.fields.map((f) => ({ name: f.name, source: f.source, decode: f.decode, ops: listing([...f.pre, ...f.body]), pre: f.pre.length, body: f.body.length })) }),
    });
  }
  return { roots: out };
}

export const docs = async () => DOCS;
export const schema = async () => SDL;
export const probes = () => status();
