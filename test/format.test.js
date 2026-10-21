import assert from "node:assert/strict";
import { test } from "node:test";

import { format } from "../app/lib/gql/format.js";
import { parse } from "../app/lib/gql/parse.js";

test("format prints two-space indent, one field per line, args and directives inline", () => {
  const out = format(`query { tcp(ports:[80,443],limit:20, iface: "lo", proto: tcp) { hook comm c: cwnd @when(gt: 10) tcphdr { window syn } req: payload(len: 48, kind: text) } }`);
  assert.equal(
    out,
    `{
  tcp(ports: [80, 443], limit: 20, iface: "lo", proto: tcp) {
    hook
    comm
    c: cwnd @when(gt: 10)
    tcphdr {
      window
      syn
    }
    req: payload(len: 48, kind: text)
  }
}
`,
  );
});

test("formatting is a fixed point and preserves the tree", () => {
  const q = `{ udp(ports: [53], data: true) { saddr q: payload(offset: 12, len: 40, kind: bytes) } struct(name: "udphdr") { members { name offset } } }`;
  const once = format(q);
  assert.equal(format(once), once);
  const noLines = (x) => (Array.isArray(x) ? x.map(noLines) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "line").map(([k, v]) => [k, noLines(v)])) : x);
  assert.deepEqual(noLines(parse(once)), noLines(parse(q)));
});

test("a query that does not parse is left to its error", () => {
  assert.throws(() => format("{ tcp { "), /unclosed/);
});
