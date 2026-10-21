/* Run a query from the command line, through the same path the HTTP
 * route takes.
 *
 *   yeet run scripts/query.js -- --q '{ tcp(ports: [80], limit: 5) { hook comm daddr dport cwnd srtt req: payload(len: 48, kind: text) } }'
 *   yeet run scripts/query.js -- --explain --q '{ tcp { inflight: sndNxt @minus(field: "sndUna") } }'
 *   yeet run scripts/query.js -- --q '{ struct(name: "udphdr") { members { name offset size kind } } }'
 */
import { execute, explain } from "../app/lib/query.js";
import { stopAll } from "../app/lib/probes/registry.js";

const argv = yeet.args ?? {};
const q = String(argv.q ?? "{ roots { name object hook } }");
const result = argv.explain ? await explain(q) : await execute(q);
console.log(JSON.stringify(result, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
await stopAll();
yeet.exit(result.errors?.length && !result.data ? 1 : 0);
