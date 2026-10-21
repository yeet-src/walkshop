"use yeet";

/* The runs: every query the page has started, each streaming into
 * its own buffer until stopped. Called from Node (actions.js) on
 * behalf of the workbench island, since an island cannot reach the
 * isolate directly.
 *
 * A run starts and the call returns at once — a call from Node has
 * thirty seconds, a run has as long as you like — and the island
 * polls for what is new. Several runs may be going at once, on the
 * same root too: the loader merges their fields into one program and
 * hands each its own rows (attach.js). The isolate is one application
 * shared by every tab, so the runs are shared: a run started in one
 * browser is a tab in every browser. */

import { plan } from "./gql/plan.js";
import { columnsOf, flatten } from "./gql/shape.js";
import { stopToken } from "./probes/attach.js";
import { execute, explain } from "./query.js";

/* Rows kept per root per run; the table shows the same, newest first. */
const KEEP = 500;
const PAGE = 48;

/* How the prefix columns read, for the table's colours; VM columns get
 * theirs from the compiler, once explain() answers. */
const PREFIX_KINDS = {
  ts: "uint", at: "uint", cpu: "uint", hook: "hook", ifindex: "uint", pid: "uint", tid: "uint", comm: "str",
  family: "uint", proto: "uint", saddr: "ip4", daddr: "ip4", sport: "port", dport: "port", seq: "uint", len: "uint", linear: "uint", regs: "hex",
};

/* A reshaped row's keys, dotted, for columns. */
const flattenDeep = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenDeep(v, key, out);
    else out[key] = v;
  }
  return out;
};
const kindOfValue = (v) => (typeof v === "number" ? "uint" : typeof v === "boolean" ? "bool" : typeof v === "string" ? (/^\d+\.\d+\.\d+\.\d+$/.test(v) ? "ip4" : "str") : "str");

const runs = new Map();
let nextId = 1;
let seq = 0;

const summary = (r) => ({ id: r.id, text: r.text, busy: r.busy, roots: r.roots, at: r.at, count: Object.values(r.rows).reduce((n, l) => n + l.length, 0), errors: r.errors.length });

/** Every run, newest last. */
export async function listRuns() {
  return [...runs.values()].map(summary);
}

/** Stop a run; its rows stay until it is closed. */
export async function stopRun(id) {
  const r = runs.get(Number(id));
  r?.stop.abort();
  return { ok: Boolean(r) };
}

/** Stop and forget a run. */
export async function closeRun(id) {
  const r = runs.get(Number(id));
  if (!r) return { ok: false };
  r.stop.abort();
  runs.delete(r.id);
  return { ok: true };
}

/**
 * Start a run of `text`. With `id`, that run is stopped and replaced in
 * place (the tab keeps its number); without, a new one. Returns at
 * once with `{ id, errors }` — a query that does not plan is a run
 * that ended before it began, with its errors. A run goes until it is
 * stopped (the workbench's way); with `forever: false` the query's own
 * `limit` and `ms` end it (the HTTP stream's way).
 */
/* A row on the console lane, in the view's own framing so the dev
 * server's tap strips it and the page's client ignores it (an op it
 * does not know), while the workbench's own socket reads it. */
const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";
const ascii = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const push = (frame) => console.log(`${OSC_OPEN}${ascii(JSON.stringify(frame))}${OSC_CLOSE}`);

export async function startRun(id, text, { push: pushRows = false, forever = true } = {}) {
  const q = String(text ?? "");
  const old = id ? runs.get(Number(id)) : null;
  old?.stop.abort();
  const run = {
    id: old?.id ?? nextId++,
    text: q,
    busy: true,
    roots: [],
    columns: {},
    rows: {},
    plans: [],
    errors: [],
    meta: {},
    at: Date.now(),
    stop: stopToken(),
  };
  runs.set(run.id, run);

  let planned;
  try {
    planned = plan(q);
  } catch (e) {
    run.busy = false;
    run.errors = [{ message: String(e?.message ?? e), line: e?.line ?? 1 }];
    return { id: run.id, errors: run.errors };
  }
  run.roots = planned.roots.map((r) => r.key);
  run.columns = Object.fromEntries(
    planned.roots.map((r) => [r.key, columnsOf(r.layout).map((c) => ({ ...c, kind: c.source === "prefix" ? (PREFIX_KINDS[c.name] ?? "uint") : null }))]),
  );
  /* With a pipeline the selection's columns are only a hint: a row may
   * drop or add keys. Start from what the selection names and let the
   * rows add to it; a column the first rows never carry stays empty. */
  for (const key of run.roots) run.rows[key] = [];

  explain(q)
    .then((p) => {
      run.plans = p.roots ?? [];
      for (const r of run.plans) {
        const byName = Object.fromEntries((r.fields ?? []).map((f) => [f.name, f.decode]));
        run.columns[r.key] = (run.columns[r.key] ?? []).map((c) =>
          c.source === "vm" && byName[c.name] ? { ...c, kind: byName[c.name].kind, size: byName[c.name].size, window: byName[c.name].payload != null || ["text", "auto", "bytes", "json"].includes(byName[c.name].kind) } : c,
        );
      }
    })
    .catch(() => {});

  const reshaped = Boolean(planned.pipeline);
  const onRow = (key, shaped, row) => {
    if (run.stop.aborted) return;
    /* With a pipeline the row is whatever the transform returned: the
     * columns are its keys, learned as rows arrive; a key the selection
     * had keeps its kind, a new one takes its kind from the value. */
    if (reshaped) {
      const cols = run.columns[key] ?? (run.columns[key] = []);
      for (const [k, v] of Object.entries(flattenDeep(shaped))) {
        if (!cols.some((c) => c.key === k)) cols.push({ key: k, path: k.split("."), source: "pipe", name: k, kind: kindOfValue(v) });
      }
      run.columns[key] = cols;
    }
    const flat = flatten(shaped, run.columns[key] ?? []);
    flat._seq = ++seq;
    /* The packet's payload length rides along, so an empty window can
     * say whether there was nothing to read or the read failed. */
    if (row?.len != null) flat._len = row.len;
    /* The kernel's clock for the packet (ns since boot) and the host's
     * wall clock when the row arrived: together they date every packet
     * to the microsecond without a clock call in the kernel. */
    if (row?.ts != null) flat._ts = String(row.ts);
    if (row?.at != null) flat._at = row.at;
    const raw = {};
    for (const c of run.columns[key] ?? []) if (c.source === "vm" && row?.raw?.[c.name] != null) raw[c.key] = row.raw[c.name];
    if (Object.keys(raw).length) flat._raw = raw;
    const list = run.rows[key] ?? (run.rows[key] = []);
    list.push(flat);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    if (pushRows) push({ op: "walkshop", run: run.id, key, row: flat });
  };

  /* Not awaited: the run outlives this call. */
  execute(q, { onRow, stop: run.stop, forever })
    .then((r) => {
      run.meta = Object.fromEntries(planned.meta.map((m) => [m.key, r.data?.[m.key] ?? null]));
      run.errors = r.errors ?? [];
      run.busy = false;
    })
    .catch((e) => {
      run.errors = [{ message: String(e?.message ?? e) }];
      run.busy = false;
    });

  /* Let a compile error surface before the caller moves on. */
  await new Promise((r) => setTimeout(r, 50));
  return { id: run.id, errors: run.errors };
}

/**
 * What the workbench polls for one run: its status, columns, plans,
 * and each root's rows newer than `after[key]`, in order of arrival.
 * `{ gone: true }` for a run that was closed.
 */
export async function pollRun(id, after = {}) {
  const r = runs.get(Number(id));
  if (!r) return { gone: true };
  /* At most PAGE rows per root per poll — a window can be 4 KiB, and
   * a reply is one message — with `more` when there is a backlog, so
   * the island asks again at once. */
  const rows = {};
  const latest = {};
  let more = false;
  for (const key of r.roots) {
    const list = r.rows[key] ?? [];
    const from = Number(after[key] ?? 0);
    const fresh = from ? list.filter((x) => x._seq > from) : list;
    if (fresh.length > PAGE) more = true;
    rows[key] = fresh.slice(0, PAGE);
    latest[key] = rows[key].length ? rows[key][rows[key].length - 1]._seq : from;
  }
  return { id: r.id, at: r.at, busy: r.busy, roots: r.roots, columns: r.columns, plans: r.plans, errors: r.errors, meta: r.meta, rows, latest, more, keep: KEEP };
}
