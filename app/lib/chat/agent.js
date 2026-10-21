"use yeet";

/* The chat: one shared conversation in the isolate, an agent that
 * answers with Markdown and blocks, the reply streamed over the lane.
 *
 * send() returns at once; the turn runs on. Each delta is a frame; the
 * finished reply is parsed for blocks and each is started (run.js),
 * which pushes its drawing to the page. The model's one tool is the
 * query language itself, so it can look before it draws. */

import { runTool, stream, tool } from "yeet:ai";

import { push } from "../lane.js";
import { parseBlocks } from "./blocks.js";
import { SYSTEM } from "./prompt.js";
import { counts, lastEver, onChange, onWake, runSnippet, runningBlock, setBoard, startBlock, stopAllBlocks, stopBlock } from "./run.js";

const argOf = (name) => {
  const args = globalThis.yeet?.args;
  const v = args && typeof args === "object" && !Array.isArray(args) ? args[name] : null;
  return typeof v === "string" && v.length > 0 ? v : null;
};
const MODEL = argOf("model") ?? "claude-opus-5";

const MAX_TURNS = 5;
const MAX_TOKENS = 3000;
const RESULT_LIMIT = 8000;
const HISTORY = 20; /* messages kept as context */

const messages = []; /* { id, role, text, at, status?, error?, steps?, kind? } */
let nextId = 1;
let current = null; /* { id, cancelled, stream } */

/* One player. A watch that fires does not start a turn on its own: it
 * joins a queue, one entry per watch (a newer fire replaces an older
 * one still waiting), and the next turn starts when the current one
 * ends. A person's message goes ahead of the queue. */
const wakes = new Map(); /* watch id → { title, payload, fires, at } */
const MAX_WAKES = 8;

const clock = (t) => new Date(t).toTimeString().slice(0, 8);

/* The pinboard: blocks pinned to the dashboard, shared by every
 * viewer. A pin is the block's identity and its span; the page draws
 * it from the same snapshots it already receives, seeded with the
 * last one for a page that arrives late. */
const pinsMap = new Map(); /* id → { id, name, attrs, src, span, at } */
const pinList = () => [...pinsMap.values()].map((p) => ({ ...p, last: lastEver(p.id) }));
const announcePins = () => push({ op: "walkshop-chat", pins: pinList() });

export async function pins() {
  return pinList();
}

export async function pin(id, { span } = {}) {
  const have = pinsMap.get(id);
  const seg = have ?? [...messages].flatMap((m) => parseBlocks(m.text ?? "")).find((s) => s.t === "block" && s.id === id);
  if (!seg) return { ok: false };
  pinsMap.set(id, { id, name: seg.name, attrs: seg.attrs, src: seg.src, span: Math.max(1, Math.min(3, Number(span ?? have?.span ?? seg.attrs?.span) || 1)), at: have?.at ?? Date.now() });
  announcePins();
  return { ok: true };
}

export async function unpin(id) {
  const ok = pinsMap.delete(id);
  announcePins();
  return { ok };
}

/* The board as the agent works it, from a snippet or a block: tiles
 * by id or by title, synchronous, every change pushed to the page. */
const blockByRef = (ref) => {
  const r = String(ref ?? "");
  for (const p of pinsMap.values()) if (p.id === r || p.attrs?.title === r) return p;
  for (const m of [...messages].reverse()) for (const seg of parseBlocks(m.text ?? "")) if (seg.t === "block" && (seg.id === r || seg.attrs?.title === r)) return seg;
  return null;
};
setBoard({
  list: () => [...pinsMap.values()].map((p, i) => ({ index: i, id: p.id, title: p.attrs?.title ?? null, object: p.name, span: p.span })),
  pin: (ref, opts = {}) => {
    const seg = blockByRef(ref);
    if (!seg) return false;
    const have = pinsMap.get(seg.id);
    pinsMap.set(seg.id, { id: seg.id, name: seg.name, attrs: seg.attrs, src: seg.src, span: Math.max(1, Math.min(3, Number(opts.span ?? have?.span ?? seg.attrs?.span) || 1)), at: have?.at ?? Date.now() });
    announcePins();
    return true;
  },
  unpin: (ref) => {
    const seg = blockByRef(ref);
    if (!seg || !pinsMap.has(seg.id)) return false;
    pinsMap.delete(seg.id);
    announcePins();
    return true;
  },
  span: (ref, n) => {
    const seg = blockByRef(ref);
    const p = seg && pinsMap.get(seg.id);
    if (!p) return false;
    p.span = Math.max(1, Math.min(3, Number(n) || 1));
    announcePins();
    return true;
  },
  move: (ref, index) => {
    const seg = blockByRef(ref);
    if (!seg || !pinsMap.has(seg.id)) return false;
    const list = [...pinsMap.values()].filter((p) => p.id !== seg.id);
    list.splice(Math.max(0, Math.min(list.length, Number(index) || 0)), 0, pinsMap.get(seg.id));
    pinsMap.clear();
    for (const p of list) pinsMap.set(p.id, p);
    announcePins();
    return true;
  },
  stop: (ref) => {
    const seg = blockByRef(ref);
    return seg ? stopBlock(seg.id) : false;
  },
  clear: () => {
    pinsMap.clear();
    announcePins();
    return true;
  },
});

/* The chat's state, for the header: pushed whenever it changes, and
 * answered to a fresh page. */
export async function status() {
  return { busy: Boolean(current), queued: wakes.size, pinned: pinsMap.size, ...counts() };
}
const announce = () => status().then((st) => push({ op: "walkshop-chat", status: st })).catch(() => {});
onChange(announce);

function drain() {
  if (current || !wakes.size) return;
  const [id, w] = wakes.entries().next().value;
  wakes.delete(id);
  const text = `[watch "${w.title}" fired at ${clock(w.at)}${w.fires > 1 ? `, fire ${w.fires}` : ""}]\n${typeof w.payload === "string" ? w.payload : JSON.stringify(w.payload)}`;
  const user = { id: nextId++, role: "user", text, at: w.at, status: "done", kind: "wake" };
  messages.push(user);
  frame(user, { text, kind: "wake" });
  const reply = { id: nextId++, role: "assistant", text: "", at: Date.now(), status: "thinking", steps: [] };
  messages.push(reply);
  frame(reply, { text: "" });
  const run = { id: reply.id, cancelled: false, stream: null };
  current = run;
  announce();
  turn(reply, run).catch(() => {});
}

onWake((w) => {
  if (wakes.size >= MAX_WAKES && !wakes.has(w.id)) return;
  wakes.set(w.id, { ...w, at: Date.now() });
  announce();
  drain();
});

/* The one tool is code: the same environment a block has, run once,
 * and whatever it returns comes back. The model does not call a
 * "query" tool; it writes `await query("…")` and returns what it
 * wants to see — a count, a slice, an aggregate — so the result is
 * already the size and shape it needs. */
const tools = [
  tool({
    name: "js",
    description: "Run JavaScript on the host and get back what it returns, as JSON. Globals: query(text) — a walkshop query (the language in your instructions) → its data by root; state — a scratch object that lives for the conversation. Top-level await. Return a small value: a count, a few rows, an aggregate; large results are truncated. Use it to look before you place a block.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: 'e.g. `const d = await query("{ tcp(data: true, limit: 30, ms: 800) { daddr srtt } }"); return d.tcp.slice(0, 5);`' } },
      required: ["code"],
    },
    async handler({ code }) {
      return runSnippet(String(code ?? ""), { limit: RESULT_LIMIT });
    },
  }),
];

const frame = (m, extra = {}) => push({ op: "walkshop-chat", id: m.id, role: m.role, status: m.status, at: m.at, ...extra });

/** What the chat runs on. */
export async function info() {
  return { model: MODEL, source: argOf("model") ? "yeet.args.model (yeetkit.config.js / --model)" : "the code's default" };
}

export async function history() {
  return messages.map((m) => ({ id: m.id, role: m.role, text: m.text, at: m.at, status: m.status ?? "done", error: m.error ?? null, steps: m.steps ?? [], kind: m.kind ?? null }));
}

export async function clearChat() {
  current?.stream?.cancel?.().catch(() => {});
  if (current) current.cancelled = true;
  messages.length = 0;
  wakes.clear();
  pinsMap.clear();
  stopAllBlocks();
  announce();
  announcePins();
  push({ op: "walkshop-chat", cleared: true });
  return { ok: true };
}

/** Send a user message; the reply streams. Returns the reply's id at once. */
export async function send(text) {
  const q = String(text ?? "").trim();
  if (!q) return { ok: false };
  if (current) {
    current.cancelled = true;
    current.stream?.cancel?.().catch(() => {});
  }
  const user = { id: nextId++, role: "user", text: q, at: Date.now(), status: "done" };
  messages.push(user);
  frame(user, { text: q });
  const reply = { id: nextId++, role: "assistant", text: "", at: Date.now(), status: "thinking", steps: [] };
  messages.push(reply);
  frame(reply, { text: "" });
  const run = { id: reply.id, cancelled: false, stream: null };
  current = run;
  announce();
  turn(reply, run).catch(() => {});
  return { ok: true, id: reply.id };
}

async function turn(reply, run) {
  const context = messages
    .filter((m) => m.id < reply.id && m.status === "done" && m.text)
    .slice(-HISTORY)
    .map((m) => ({ role: m.role, content: m.text }));
  const convo = [...context];
  if (pinsMap.size) {
    const tiles = [...pinsMap.values()].map((p, i) => `${i}: ${p.name}${p.attrs?.title ? ` "${p.attrs.title}"` : ""} span ${p.span}`).join("; ");
    convo.push({ role: "user", content: `[the dashboard now has ${pinsMap.size} tile${pinsMap.size === 1 ? "" : "s"}: ${tiles}. Change it with board.* in a js call when the request is about it; a new block with pin=true adds a tile.]` });
  }
  try {
    for (let t = 0; t < MAX_TURNS && !run.cancelled; t++) {
      const last = t === MAX_TURNS - 1;
      if (last) convo.push({ role: "user", content: "Answer now from what you have: two sentences at most, then the block(s)." });
      const s = stream({ model: MODEL, system: SYSTEM, max_tokens: MAX_TOKENS, messages: convo, ...(last ? {} : { tools }) });
      run.stream = s;
      let text = "";
      const started = new Set(); /* block ids already running */
      for await (const ev of s) {
        if (run.cancelled) break;
        if (ev.type === "text") {
          text += ev.delta ?? "";
          reply.text = text;
          reply.status = "streaming";
          frame(reply, { delta: ev.delta ?? "" });
          /* A block runs the moment its closing ::: arrives, not when
           * the reply ends: the page turns it into its component while
           * the agent is still writing the rest. */
          if ((ev.delta ?? "").includes(":::")) {
            for (const seg of parseBlocks(text)) {
              if (seg.t === "block" && seg.known && !started.has(seg.id)) {
                started.add(seg.id);
                startBlock({ id: seg.id, name: seg.name, attrs: seg.attrs, src: seg.src }).catch(() => {});
                if (seg.attrs.pin === true || seg.attrs.pin === "true" || seg.attrs.dash === true) pin(seg.id, { span: seg.attrs.span }).catch(() => {});
              }
            }
          }
        } else if (ev.type === "tool_call") {
          reply.status = "tool";
          frame(reply, {});
        }
      }
      const result = await s.result;
      run.stream = null;
      if (run.cancelled) break;
      if (!result.tool_calls?.length) {
        reply.text = result.text || text;
        break;
      }
      convo.push({
        role: "assistant",
        content: [...(result.text ? [{ type: "text", text: result.text }] : []), ...result.tool_calls.map((c) => ({ type: "tool_call", id: c.id, name: c.name, arguments: c.arguments }))],
      });
      if (result.text?.trim()) reply.steps.push({ kind: "note", text: result.text.trim() });
      reply.text = "";
      frame(reply, { reset: true });
      const outcomes = [];
      for (const call of result.tool_calls) {
        const step = { kind: "tool", name: call.name, args: call.arguments ?? {}, ms: null, error: null };
        reply.steps.push(step);
        const index = reply.steps.length - 1;
        frame(reply, { step });
        const started = Date.now();
        try {
          const out = await runTool(tools, call);
          step.ms = Date.now() - started;
          if (typeof out.result === "string" && /^(error|syntax):/.test(out.result)) step.error = out.result.slice(0, 300);
          outcomes.push(out);
        } catch (e) {
          step.ms = Date.now() - started;
          step.error = String(e?.message ?? e);
          outcomes.push({ tool_call_id: call.id, name: call.name, result: `error: ${step.error}` });
        }
        /* The step again, finished: the page only had its start. */
        frame(reply, { stepDone: { index, ms: step.ms, error: step.error } });
      }
      convo.push({ role: "user", content: outcomes.map((o) => ({ type: "tool_result", tool_call_id: o.tool_call_id, name: o.name, result: o.result })) });
    }
    reply.status = run.cancelled ? "cancelled" : "done";
  } catch (e) {
    reply.status = run.cancelled ? "cancelled" : "error";
    const msg = String(e?.message ?? e);
    /* The daemon answers for the account it was logged in as; after a
     * restart it may have none until `yeet login` runs again. */
    reply.error = /WhoAmI/.test(msg) ? `${msg} — the daemon has no account: run \`yeet login\` on the host, then ask again` : msg;
  } finally {
    if (current === run) current = null;
    frame(reply, { text: reply.text, done: true, error: reply.error ?? null, steps: reply.steps });
    announce();
    if (reply.status === "done") {
      /* Anything the streaming pass did not catch (a block closed by the
       * final token); startBlock restarts an id, so it is idempotent. */
      for (const seg of parseBlocks(reply.text)) {
        if (seg.t === "block" && seg.known && !runningBlock(seg.id)) {
          await startBlock({ id: seg.id, name: seg.name, attrs: seg.attrs, src: seg.src });
          if (seg.attrs.pin === true || seg.attrs.pin === "true" || seg.attrs.dash === true) await pin(seg.id, { span: seg.attrs.span });
        }
      }
    }
    /* the next wake, if one waited */
    setTimeout(drain, 0);
  }
}
