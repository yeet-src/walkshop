import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeEntry, decodeEvent } from "../app/lib/vm/decode.js";
import { EDATA, MAX_FIELDS, MAX_ITERS, NREGS } from "../app/lib/vm/ops.js";

test("entries decode by kind", () => {
  assert.equal(decodeEntry([10, 0, 0, 0], 4, { kind: "uint", size: 4 }), 10);
  assert.equal(decodeEntry([0xff, 0xff, 0xff, 0xff], 4, { kind: "int", size: 4 }), -1);
  assert.equal(decodeEntry([0x01, 0xbb], 2, { kind: "be", size: 2 }), 443);
  assert.equal(decodeEntry([127, 0, 0, 1], 4, { kind: "ip4", size: 4 }), "127.0.0.1");
  assert.equal(decodeEntry([..."lo\0\0\0"].map((c) => c.charCodeAt(0)), 5, { kind: "str", size: 16 }), "lo");
  assert.equal(decodeEntry([71, 69, 84, 32, 0x01], 5, { kind: "text", size: 5 }), "GET ·");
  assert.equal(decodeEntry([0xde, 0xad], 2, { kind: "bytes", size: 2 }), "dead");
  assert.equal(decodeEntry([1, 2, 3, 4, 5, 6], 6, { kind: "mac", size: 6 }), "01:02:03:04:05:06");
  assert.equal(decodeEntry([0x12, 0x02], 2, { kind: "uint", size: 2, bitfield: { bit_offset: 9, bit_size: 1 } }), 1, "syn bit of 0x0212");
  assert.equal(decodeEntry([..."{\"id\": 42}"].map((c) => c.charCodeAt(0)), 10, { kind: "json", size: 10, field: "id" }), 42);
  assert.equal(decodeEntry([1], 1, { kind: "enum", size: 1, values: { 1: "ONE" } }), "ONE");
});

function event(over = {}) {
  const e = {
    ts: 1234n, cpu: 3, gen: 7, ok: 0b11, root: 1, hook: 1, family: 2, proto: 6, ifindex: 1, pid: 42, tid: 43,
    comm: [..."curl"].map((c) => c.charCodeAt(0)).concat(new Array(12).fill(0)),
    sport: 40000, dport: 80, saddr: [127, 0, 0, 1].concat(new Array(12).fill(0)), daddr: [127, 0, 0, 1].concat(new Array(12).fill(0)),
    seq: 99, len: 10, linear: 10,
    regs: new Array(NREGS).fill(0n), fcount: new Array(MAX_FIELDS).fill(1), eoff: new Array(MAX_FIELDS * MAX_ITERS).fill(0), elen: new Array(MAX_FIELDS * MAX_ITERS).fill(0), edata: new Array(EDATA).fill(0),
  };
  e.regs[2] = 0x1000n;
  e.regs[3] = 0x100en; /* an Ethernet header is present */
  return { walk_event: { ...e, ...over } };
}

test("an event becomes a row; a failed field is null; a payload window is cut to linear", () => {
  const e = event();
  e.walk_event.elen[0] = 4;
  e.walk_event.edata[0] = 10;
  e.walk_event.eoff[MAX_ITERS] = 4; /* packed right after the first entry */
  e.walk_event.elen[MAX_ITERS] = 8;
  for (let i = 0; i < 8; i++) e.walk_event.edata[4 + i] = "GET / HT".charCodeAt(i);
  const fields = [
    { name: "cwnd", decode: { kind: "uint", size: 4 } },
    { name: "req", decode: { kind: "text", size: 8, payload: 4 } },
    { name: "gone", decode: { kind: "uint", size: 4 } },
  ];
  const row = decodeEvent(e, fields);
  assert.equal(row.root, "tcp");
  assert.equal(row.hook, "tx");
  assert.equal(row.comm, "curl");
  assert.equal(row.saddr, "127.0.0.1");
  assert.equal(row.dport, 80);
  assert.equal(row.values.cwnd, 10);
  assert.equal(row.values.req, "GET / ", "linear 10 minus offset 4 leaves 6 bytes");
  assert.equal(row.values.gone, null);
  assert.equal(row.gen, 7);
});

test("a field that needs an L2 header is null on a raw-IP frame", () => {
  const e = event({ ok: 1 });
  e.walk_event.regs[3] = 0x1000n;
  e.walk_event.elen[0] = 6;
  const row = decodeEvent(e, [{ name: "dst", decode: { kind: "mac", size: 6, needs: "l2" } }]);
  assert.equal(row.values.dst, null);
});
