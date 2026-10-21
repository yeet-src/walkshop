/* Self-test for one root: compile a select against this kernel's BTF,
 * attach the root's object, run it, print the rows.
 *
 *   yeet run scripts/selftest.js -- --root tcp
 *   yeet run scripts/selftest.js -- --root tcp --select "cwnd, srtt, dev, req: payload(0, 64, text)" --ports 8080 --data
 *   yeet run scripts/selftest.js -- --root udp --select "ttl, ulen, q: payload(0, 32, bytes)"
 *   yeet run scripts/selftest.js -- --root xdp --iface wlp45s0 --select "ttl, ip.protocol, tcphdr.window"
 *   yeet run scripts/selftest.js -- --root https --select "line: payload(0, 80, text)"
 *   yeet run scripts/selftest.js -- --root tcp --plan --select "..."     the ops, without attaching
 *
 * Generate traffic meanwhile (curl a few sites).
 */
import btf from "yeet:btf";

import { attachObject, objectSpec } from "../app/lib/probes/attach.js";
import { ROOTS } from "../app/lib/roots.js";
import { compileFields } from "../app/lib/vm/emit.js";
import { listing } from "../app/lib/vm/ops.js";
import { parseSelect } from "../app/lib/vm/select.js";

const DEFAULTS = {
  tcp: "cwnd, srtt, dev, ttl, window, req: payload(0, 48, text)",
  udp: "ttl, ulen, dev, q: payload(0, 24, bytes)",
  xdp: "ttl, ip.protocol, window, ulen",
  https: "line: payload(0, 80, text)",
};

const argv = yeet.args ?? {};
const rootName = String(argv.root ?? "tcp");
const root = ROOTS[rootName];
if (!root) {
  console.error(`unknown root ${rootName}; one of ${Object.keys(ROOTS).join(", ")}`);
  yeet.exit(1);
}
const entries = parseSelect(root, String(argv.select ?? DEFAULTS[rootName]));
const limit = Number(argv.limit ?? 20);
const ms = Number(argv.ms ?? 5000);

const fields = await compileFields(btf, root, entries);
for (const f of fields) console.log(`${f.name.padEnd(12)} ${JSON.stringify(f.decode).padEnd(44)} ${listing([...f.pre, ...f.body])}`);
if (argv.plan) yeet.exit(0);

const scope = {};
if (argv.iface) scope.iface = String(argv.iface).split(",");
if (argv.binary) scope.binary = String(argv.binary);
if (argv.pid) scope.pid = Number(argv.pid);

const handle = await attachObject(root.object, objectSpec(root.object, import.meta.dirname), {
  scope,
  ignorePorts: [3600, 3601],
  onError: (e) => console.error("walk:", e?.message ?? e),
});
console.log(`attached ${root.object} (${JSON.stringify({ ...handle.attached, builder: undefined })}); capturing up to ${limit} rows for ${ms} ms…`);
const ports = String(argv.ports ?? "").split(",").map(Number).filter(Boolean);
const rows = await handle.capture(root.slot, fields, {
  limit,
  ms,
  every: Number(argv.every ?? 0),
  ports,
  data: Boolean(argv.data),
  pid: argv.pid ? Number(argv.pid) : undefined,
  proto: argv.proto ? String(argv.proto) : undefined,
});
for (const r of rows) {
  const who = r.pid ? ` ${r.comm}[${r.pid}]` : "";
  console.log(`${(Number(r.ts % 1_000_000_000n) / 1e6).toFixed(1).padStart(7)}ms cpu${r.cpu} ${r.hook} if${r.ifindex}${who} ${r.saddr}:${r.sport} → ${r.daddr}:${r.dport} len=${r.len}/${r.linear}  ${JSON.stringify(r.values)}`);
}
console.log(`${rows.length} rows; counters ${JSON.stringify(await handle.stats())}`);
await handle.stop();
