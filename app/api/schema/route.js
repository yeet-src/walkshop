/* GET /api/schema — the SDL alone. */

import { schema } from "@/lib/query.js";

export async function GET() {
  return new Response(await schema(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
