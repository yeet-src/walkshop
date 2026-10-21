/* POST /api/query — run a query.
 *
 *   curl -s localhost:3600/api/query -d '{ "query": "{ tcp(limit: 5) { daddr dport cwnd } }" }'
 *   curl -s localhost:3600/api/query -H 'content-type: application/graphql' -d '{ tcp(limit: 5) { daddr dport cwnd } }'
 *   curl -s 'localhost:3600/api/query?query=%7B%20roots%20%7B%20name%20%7D%20%7D'
 *   curl -s localhost:3600/api/query -d '{ "query": "…", "explain": true }'   the ops, without running
 *   curl -sN 'localhost:3600/api/query?stream=1' -d '{ tcp(ms: 60000) { daddr srtt } }'   rows as they arrive: a Markdown table, a line per row
 *   curl -sN 'localhost:3600/api/query?stream=1' -H 'accept: application/x-ndjson' -d '…'  the same, one JSON object per line
 *
 * Standard GraphQL shape in the one-shot reply: `{ data }`, or
 * `{ data, errors }` with a line per error. A query that yields no
 * data at all is a 400.
 *
 * Streamed, the run is a session run — the same thing a workbench tab
 * is — polled here and written out as it fills; it ends when `limit`
 * or `ms` is reached, or when the client hangs up. A query that names
 * neither runs until the client does: streamed, the defaults of 50 rows
 * and 2 s do not apply. */

import { close, poll, start } from "@/lib/actions.js";
import { header, line, table } from "@/lib/gql/markdown.js";
import { execute, explain } from "@/lib/query.js";

const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A streamed row, without the workbench's bookkeeping; `at` (host ms)
 * and `ts` (kernel ns) stay, named plainly. */
function plain(row) {
  const { _seq, _raw, _len, _ts, _at, ...rest } = row;
  const out = { ...rest };
  if (_at != null) out.at = _at;
  if (_ts != null) out.ts = _ts;
  if (_len != null && !("len" in out)) out.len = _len;
  return out;
}

/* A stream is a Markdown table unless the client asks for NDJSON. The
 * one-shot reply is JSON unless the client asks for Markdown, which is
 * then a table per root. */
const accept = (request) => request.headers.get("accept") ?? "";
const wantsNdjson = (request, url) => /x-ndjson/i.test(accept(request)) || url.searchParams.get("format") === "ndjson";
const wantsMarkdown = (request) => /text\/markdown/i.test(accept(request));
const wantsStream = (request, url) => (url.searchParams.has("stream") && url.searchParams.get("stream") !== "0") || /x-ndjson|text\/markdown/i.test(accept(request));

/* Markdown for the one-shot reply: a heading and a table per root,
 * errors as a quoted line each. */
function markdownOf(result) {
  const parts = [];
  for (const [root, rows] of Object.entries(result.data ?? {})) {
    if (!Array.isArray(rows)) {
      parts.push(`### ${root}\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\``);
      continue;
    }
    const keys = [...new Set(rows.flatMap((r) => Object.keys(flat(r))))];
    parts.push(`### ${root}\n\n${rows.length ? table(rows.map(flat), keys) : "_no rows_"}`);
  }
  for (const e of result.errors ?? []) parts.push(`> error: ${e.message}${e.path ? ` (${e.path})` : ""}`);
  return `${parts.join("\n\n")}\n`;
}
const flat = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};

function streamed(query, { markdown, signal }) {
  const encoder = new TextEncoder();
  let id = null;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s) => controller.enqueue(encoder.encode(s));
      const started = await start(null, query, { forever: "open" });
      id = started.id;
      if (started.errors?.length) {
        for (const e of started.errors) write(markdown ? `> error: ${e.message}\n` : `${JSON.stringify({ errors: started.errors })}\n`);
        await close(id);
        controller.close();
        return;
      }
      const after = {};
      let lastRoot = null;
      const headers = {}; /* root → the column keys its table went out with */
      const stop = async () => {
        if (closed) return;
        closed = true;
        await close(id).catch(() => {});
      };
      signal?.addEventListener("abort", stop);
      try {
        for (;;) {
          const p = await poll(id, after);
          if (p.gone) break;
          for (const root of p.roots ?? []) {
            for (const row of p.rows?.[root] ?? []) {
              const r = plain(row);
              if (markdown) {
                if (!headers[root]) headers[root] = (p.columns?.[root] ?? []).map((c) => c.key).concat(["at"]);
                if (root !== lastRoot) write(`${lastRoot ? "\n" : ""}### ${root}\n\n${header(headers[root])}\n`);
                write(`${line(r, headers[root])}\n`);
              } else {
                write(`${JSON.stringify({ root, ...r })}\n`);
              }
              lastRoot = root;
            }
            if (p.latest?.[root] != null) after[root] = p.latest[root];
          }
          if (!p.busy && !p.more) {
            for (const e of p.errors ?? []) write(markdown ? `> error: ${e.message}\n` : `${JSON.stringify({ errors: [e] })}\n`);
            for (const [k, v] of Object.entries(p.meta ?? {})) write(markdown ? `\n### ${k}\n\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\`\n` : `${JSON.stringify({ root: k, meta: v })}\n`);
            break;
          }
          if (signal?.aborted) break;
          if (!p.more) await sleep(POLL_MS);
        }
      } catch (e) {
        if (!signal?.aborted) write(markdown ? `> error: ${String(e?.message ?? e)}\n` : `${JSON.stringify({ errors: [{ message: String(e?.message ?? e) }] })}\n`);
      }
      await stop();
      try {
        controller.close();
      } catch {
        /* already closed by the client */
      }
    },
    async cancel() {
      closed = true;
      if (id != null) await close(id).catch(() => {});
    },
  });
  return new Response(stream, {
    headers: { "content-type": markdown ? "text/markdown; charset=utf-8" : "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

async function queryOf(request) {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (type.includes("application/json")) {
    const body = JSON.parse(text);
    return { query: body.query, explain: Boolean(body.explain) };
  }
  if (text.trim().startsWith("{") && /"query"\s*:/.test(text)) {
    try {
      const body = JSON.parse(text);
      return { query: body.query, explain: Boolean(body.explain) };
    } catch {
      /* raw GraphQL that happens to start with `{` */
    }
  }
  return { query: text, explain: false };
}

async function run({ query, explain: wantPlan }, request) {
  if (typeof query !== "string" || !query.trim()) return Response.json({ errors: [{ message: "send a query: { \"query\": \"{ tcp { daddr } }\" }" }] }, { status: 400 });
  if (wantPlan) return Response.json(await explain(query));
  const url = new URL(request.url);
  if (wantsStream(request, url)) return streamed(query, { markdown: !wantsNdjson(request, url), signal: request.signal });
  const result = await execute(query);
  const status = result.data == null || Object.values(result.data).every((v) => v == null) ? 400 : 200;
  if (wantsMarkdown(request)) return new Response(markdownOf(result), { status, headers: { "content-type": "text/markdown; charset=utf-8" } });
  return Response.json(result, { status });
}

export async function POST(request) {
  try {
    return await run(await queryOf(request), request);
  } catch (e) {
    return Response.json({ errors: [{ message: String(e?.message ?? e) }] }, { status: 400 });
  }
}

export async function GET(request) {
  const url = new URL(request.url);
  return run({ query: url.searchParams.get("query"), explain: url.searchParams.has("explain") }, request);
}
