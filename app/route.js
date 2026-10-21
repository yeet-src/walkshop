/* GET / — the docs for an agent, the page for a person.
 *
 * A route handler wins over the page shell, so this one has to hand
 * the shell back itself when a browser asks: a request that accepts
 * HTML gets the shell, fetched from an unclaimed path on this same
 * server (every unclaimed path serves the one shell, ports and all);
 * anything else — curl, an agent, a script — gets the same Markdown
 * as GET /api, so the first thing an agent sees at the root is the
 * whole contract. */

import { docs } from "@/lib/query.js";

export async function GET(request) {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    const url = new URL(request.url);
    url.pathname = "/__shell__";
    url.search = "";
    const shell = await fetch(url, { headers: { accept: "text/html" } });
    return new Response(await shell.text(), { status: shell.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(await docs(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
