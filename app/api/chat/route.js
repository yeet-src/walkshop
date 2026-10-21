/* /api/chat — the chat, for an agent on the outside.
 *
 *   curl -s localhost:3600/api/chat -d '{ "message": "who is this box talking to?" }'
 *   curl -s localhost:3600/api/chat -H 'content-type: text/plain' -d 'srtt per peer, live'
 *   curl -sN 'localhost:3600/api/chat?stream=1' -d 'show me the last requests'   the reply as it is written
 *   curl -s localhost:3600/api/chat                                           the conversation so far
 *   curl -s -X DELETE localhost:3600/api/chat                                 clear it, stop its blocks
 *
 * A message posted here is the same as one typed on the page: the
 * conversation is one and shared, so the reply, and the instruments
 * it places, appear on every open chat page while this call waits for
 * them. The call returns when the reply is done (or after `wait` ms,
 * at most 110 s): the text, the blocks it placed, and what the agent
 * looked at. Runs in Node; the agent runs in the isolate. */

import { parseBlocks } from "@/lib/chat/blocks.js";
import { chatClear, chatHistory, chatInfo, chatSend } from "@/lib/chatActions.js";

const MAX_WAIT_MS = 110_000;
const POLL_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function messageOf(request) {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (type.includes("application/json")) {
    const body = JSON.parse(text);
    return String(body.message ?? body.text ?? body.query ?? "");
  }
  if (text.trim().startsWith("{")) {
    try {
      const body = JSON.parse(text);
      if (typeof body.message === "string") return body.message;
    } catch {
      /* plain text that starts with a brace */
    }
  }
  return text;
}

const shape = (m) => ({
  id: m.id,
  role: m.role,
  kind: m.kind ?? null,
  status: m.status,
  at: m.at,
  text: m.text,
  error: m.error ?? null,
  looked: (m.steps ?? []).filter((s) => s.kind === "tool").map((s) => ({ code: s.args?.code ?? s.args?.query ?? null, ms: s.ms, error: s.error ?? null })),
  blocks: parseBlocks(m.text ?? "")
    .filter((s) => s.t === "block")
    .map((s) => ({ id: s.id, object: s.name, attrs: s.attrs, source: s.src })),
});

export async function GET() {
  const [h, i] = await Promise.all([chatHistory(), chatInfo()]);
  return Response.json({ model: i.model, messages: h.map(shape) });
}

export async function DELETE() {
  return Response.json(await chatClear());
}

export async function POST(request) {
  const url = new URL(request.url);
  let message;
  try {
    message = (await messageOf(request)).trim();
  } catch (e) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
  if (!message) return Response.json({ error: 'send a message: { "message": "…" } or plain text' }, { status: 400 });

  const started = await chatSend(message);
  if (!started?.ok) return Response.json({ error: "the chat did not take the message" }, { status: 503 });
  const id = started.id;
  const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get("wait") ?? MAX_WAIT_MS)));
  const deadline = Date.now() + wait;

  const find = async () => (await chatHistory()).find((m) => m.id === id) ?? null;

  if (url.searchParams.has("stream")) {
    /* The reply as text, as it is written; one trailing line of JSON with the blocks. */
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let sent = "";
        let last = null;
        while (Date.now() < deadline) {
          const m = await find();
          if (m) {
            if (m.text.startsWith(sent)) {
              const delta = m.text.slice(sent.length);
              if (delta) controller.enqueue(encoder.encode(delta));
              sent = m.text;
            } else {
              /* a tool turn reset the text: start that part over */
              controller.enqueue(encoder.encode(`\n`));
              controller.enqueue(encoder.encode(m.text));
              sent = m.text;
            }
            last = m;
            if (m.status !== "thinking" && m.status !== "streaming" && m.status !== "tool") break;
          }
          await sleep(POLL_MS);
        }
        const s = last ? shape(last) : null;
        controller.enqueue(encoder.encode(`\n${JSON.stringify({ id, status: s?.status ?? "timeout", blocks: s?.blocks ?? [], looked: s?.looked ?? [], error: s?.error ?? null })}\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  let m = null;
  while (Date.now() < deadline) {
    m = await find();
    if (m && m.status !== "thinking" && m.status !== "streaming" && m.status !== "tool") break;
    await sleep(POLL_MS);
  }
  if (!m) return Response.json({ id, status: "timeout" }, { status: 504 });
  const out = shape(m);
  return Response.json(out, { status: out.status === "error" ? 500 : out.status === "done" ? 200 : 202 });
}
