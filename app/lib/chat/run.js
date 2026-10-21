"use yeet";

/* Running a block: compile its body once, run it with the object as a
 * global, push what the object collected to the page; again every
 * `live` ms if asked, until stopped or expired.
 *
 * The body runs in its own async function whose parameters are the
 * scope — the object, query, state, attrs — so a body that declares
 * one of those merely shadows it. A run that throws is reported on
 * the block and tried again next tick. */

import { push } from "../lane.js";
import { execute } from "../query.js";
import { make, } from "./objects.js";

const MIN_LIVE = 250;
const MAX_LIVE = 60_000;
const MAX_LIVE_BLOCKS = 12;
const EXPIRE_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 20_000;
const QUERY_LIMIT = 500;
const QUERY_MS = 5000;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* The board, for the snippets and blocks: set by agent.js, which owns
 * the pins; a stub until then. */
let board = { list: () => [], pin: () => false, unpin: () => false, span: () => false, move: () => false, clear: () => false };
export function setBoard(api) {
  board = api;
}

const blocks = new Map(); /* id → { id, name, attrs, src, fn, state, object, timer, runs, startedAt, inflight } */

/* A watch that fires wakes the agent. One handler, set by agent.js;
 * the cooldown keeps a condition that stays true from firing every
 * tick. */
const WATCH_COOLDOWN_MS = 10_000;
const WATCH_MIN_EVERY = 2000;
let wakeHandler = null;
export function onWake(fn) {
  wakeHandler = fn;
}

/* Whoever wants to know when the set of running blocks changes. */
let changeHandler = null;
export function onChange(fn) {
  changeHandler = fn;
}
const changed = () => changeHandler?.();

/** The running blocks, counted: live instruments and watches. */
export function counts() {
  let live = 0;
  let watches = 0;
  for (const b of blocks.values()) {
    if (b.name === "watch") watches++;
    else if (b.timer) live++;
  }
  return { live, watches };
}

const compile = (names, source) => {
  const body = source.trim();
  try {
    return new AsyncFunction(...names, `"use strict";\nreturn await (async () => (\n${body}\n))();`);
  } catch {
    return new AsyncFunction(...names, `"use strict";\nreturn await (async () => {\n${body}\n})();`);
  }
};

/* The bounded query a body may call. */
async function boundedQuery(text) {
  const r = await execute(String(text ?? ""));
  if (r.errors?.length && !r.data) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.data ?? {};
}

async function runOnce(b) {
  if (b.inflight) return;
  b.inflight = true;
  const started = Date.now();
  /* One object for the block's life: a chart keeps its points between
   * runs. What must start over each run (a canvas, a ui tree) says so
   * with reset(); what aggregates a run's pushes says so with flush(). */
  const object = (b.object ??= make(b.name, b.attrs));
  if (!object) {
    push({ op: "walkshop-ui", block: b.id, error: `no such object: ${b.name}` });
    b.inflight = false;
    return;
  }
  if (b.name === "done") {
    /* The agent is finished: every block of the chat goes, this one too. */
    const n = blocks.size;
    stopAllBlocks();
    push({ op: "walkshop-ui", block: b.id, name: b.name, attrs: b.attrs, data: { done: true, stopped: n }, runs: 1, ms: 0, live: false });
    return;
  }
  object.reset?.();
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`took longer than ${RUN_TIMEOUT_MS / 1000} s`)), RUN_TIMEOUT_MS));
    const returned = await Promise.race([b.fn(object.api, object.api, boundedQuery, b.state, b.attrs, b.name, object.api.h ?? undefined, board), timeout]);
    object.take?.(returned);
    object.flush?.();
    b.runs++;
    if (b.name === "watch") {
      const payload = object.fired();
      const now = Date.now();
      if (payload !== null && now - (b.lastFire ?? 0) >= WATCH_COOLDOWN_MS) {
        b.lastFire = now;
        object.noteFire(payload);
        wakeHandler?.({ id: b.id, title: b.attrs.title ?? b.id, payload, fires: object.snapshot().fires });
      }
      if (object.stopped()) stopBlock(b.id);
    }
    b.last = { data: object.snapshot(), runs: b.runs, ms: Date.now() - started, live: Boolean(b.timer), at: Date.now() };
    push({ op: "walkshop-ui", block: b.id, name: b.name, attrs: b.attrs, ...b.last });
  } catch (e) {
    push({ op: "walkshop-ui", block: b.id, name: b.name, attrs: b.attrs, error: String(e?.message ?? e), runs: b.runs });
  } finally {
    b.inflight = false;
  }
}

/* A one-shot snippet, for the agent's own looking: the same globals a
 * block has (query, state — a scratch object that lives for the chat,
 * attrs empty), and whatever it returns comes back, as JSON, cut to a
 * size the model can afford on every later turn. */
const scratch = {};
export async function runSnippet(code, { limit = 8000 } = {}) {
  let fn;
  try {
    fn = compile(["query", "state", "attrs", "ctx", "__name", "board"], String(code ?? ""));
  } catch (e) {
    return `syntax: ${String(e?.message ?? e)}`;
  }
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`took longer than ${RUN_TIMEOUT_MS / 1000} s`)), RUN_TIMEOUT_MS));
    const out = await Promise.race([fn(boundedQuery, scratch, {}, null, "js", board), timeout]);
    const text = out === undefined ? "undefined" : JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated: ${text.length} chars — return less]`;
  } catch (e) {
    return `error: ${String(e?.message ?? e)}`;
  }
}

/** Start (or restart) a block. Returns its id. */
export async function startBlock({ id, name, attrs = {}, src }) {
  stopBlock(id);
  let fn;
  try {
    /* The object under its own name and under `ctx` — the name a body
     * reaches for with a canvas, and harmless for the rest. */
    fn = compile([name, "ctx", "query", "state", "attrs", "__name", "h", "board"], src);
  } catch (e) {
    push({ op: "walkshop-ui", block: id, name, attrs, error: `syntax: ${String(e?.message ?? e)}` });
    return id;
  }
  const b = { id, name, attrs, src, fn, state: {}, object: null, timer: null, runs: 0, startedAt: Date.now(), inflight: false };
  blocks.set(id, b);
  /* A watch is live by nature: `every` (default 5 s, at least 2 s). */
  const live = Number(name === "watch" ? (attrs.every ?? attrs.live ?? 5000) : attrs.live);
  if (Number.isFinite(live) && live > 0) {
    const liveCount = [...blocks.values()].filter((x) => x.timer).length;
    if (liveCount < MAX_LIVE_BLOCKS) {
      const every = Math.max(name === "watch" ? WATCH_MIN_EVERY : MIN_LIVE, Math.min(MAX_LIVE, live));
      const forever = attrs.forever === true || attrs.forever === "true";
      b.timer = setInterval(() => {
        if (!forever && Date.now() - b.startedAt > EXPIRE_MS) {
          stopBlock(id);
          push({ op: "walkshop-ui", block: id, name, attrs, expired: true });
          return;
        }
        runOnce(b);
      }, every);
    }
  }
  runOnce(b);
  changed();
  return id;
}

export function runningBlock(id) {
  return blocks.has(id);
}

/** A block's last snapshot, for a page that arrived after it ran. */
export function lastOf(id) {
  return blocks.get(id)?.last ?? null;
}

const stopped = new Map(); /* id → last snapshot of a block that ended */
export function stopBlock(id) {
  const b = blocks.get(id);
  if (!b) return false;
  if (b.timer) clearInterval(b.timer);
  if (b.last) stopped.set(id, b.last);
  if (stopped.size > 64) stopped.delete(stopped.keys().next().value);
  blocks.delete(id);
  changed();
  return true;
}
export function lastEver(id) {
  return blocks.get(id)?.last ?? stopped.get(id) ?? null;
}

export function stopAllBlocks() {
  for (const id of [...blocks.keys()]) stopBlock(id);
}

export async function liveBlocks() {
  return [...blocks.values()].map((b) => ({ id: b.id, name: b.name, live: Boolean(b.timer), runs: b.runs, startedAt: b.startedAt }));
}
