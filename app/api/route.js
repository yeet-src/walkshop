/* GET /api — the page an agent reads: how to ask, the roots, the
 * schema, examples. Runs in Node; the text comes from the isolate so
 * it reflects the roots table the isolate is running. */

import { docs } from "@/lib/query.js";

export async function GET() {
  return new Response(await docs(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
