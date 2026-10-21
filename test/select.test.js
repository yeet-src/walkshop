import assert from "node:assert/strict";
import { test } from "node:test";

import { ROOTS } from "../app/lib/roots.js";
import { compileFields } from "../app/lib/vm/emit.js";
import { listing } from "../app/lib/vm/ops.js";
import { parseEntry, parseSelect } from "../app/lib/vm/select.js";
import { btf } from "./btf-stub.js";

const tcp = ROOTS.tcp;
const one = async (root, entry) => (await compileFields(btf, root, parseSelect(root, entry)))[0];
const ops = (f) => listing([...f.pre, ...f.body]);

test("parseEntry: alias, base path with kind, payload, at, arithmetic", () => {
  assert.deepEqual(parseEntry(tcp, "cwnd"), { name: "cwnd", term: { kind: "path", base: "tcp", members: ["snd_cwnd"], as: null, size: null, alias: "cwnd" } });
  assert.deepEqual(parseEntry(tcp, "st: sock.__sk_common.skc_state(hex)").term, { kind: "path", base: "sock", members: ["__sk_common", "skc_state"], as: "hex", size: null, alias: null });
  assert.deepEqual(parseEntry(tcp, "req: payload(32, 96, text)").term, { kind: "raw", reg: 5, offset: 32, len: 96, as: "text", skb: true });
  assert.deepEqual(parseEntry(tcp, "raw: sock.at(0, 8, hex)").term, { kind: "raw", reg: 0, offset: 0, len: 8, as: "hex" });
  assert.deepEqual(parseEntry(tcp, "id: payload(0, 200, json:id)").term.as, "json:id");
  const a = parseEntry(tcp, "inflight: sndNxt - sndUna");
  assert.equal(a.term.kind, "arith");
  assert.equal(a.term.sign, "-");
  assert.deepEqual(a.term.b.members, ["snd_una"]);
  assert.throws(() => parseEntry(tcp, "cwnd(volts)"), /unknown kind/);
  assert.throws(() => parseEntry(tcp, "42"), /number alone/);
  assert.throws(() => parseEntry(tcp, "nope.x"), /unknown base/);
});

test("a plain member: base, offset, read — with the kind from its typedef", async () => {
  const c = await one(tcp, "cwnd");
  assert.equal(c.name, "cwnd");
  assert.equal(ops(c), "base sk; off 1492; read 4");
  assert.deepEqual(c.decode, { kind: "uint", size: 4 });

  const d = await one(tcp, "sock.__sk_common.skc_dport");
  assert.equal(ops(d), "base sk; off 12; read 2");
  assert.deepEqual(d.decode, { kind: "be", size: 2 });

  const q = await one(tcp, "sock.__sk_common.skc_state");
  assert.equal(ops(q), "base sk; off 18; read 1", "a volatile qualifier is peeled");
});

test("a pointer crossed is a deref hop; a char array is a string; a 6-byte array is a mac", async () => {
  const f = await one(tcp, "dev");
  assert.equal(ops(f), "base sk; off 552; deref; deref; off 288; str");
  assert.equal(f.decode.kind, "str");
  const m = await one(tcp, "eth.h_dest");
  assert.equal(ops(m), "base frame; read 6");
  assert.deepEqual(m.decode, { kind: "mac", size: 6, needs: "l2" });
});

test("the frame registers: headers by struct, big-endian from the typedef, bitfields from BTF", async () => {
  const t = await one(tcp, "ttl");
  assert.equal(ops(t), "base l3; off 8; read 1");
  const w = await one(tcp, "window");
  assert.equal(ops(w), "base l4; off 14; read 2");
  assert.deepEqual(w.decode, { kind: "be", size: 2 });
  const s = await one(tcp, "syn");
  assert.equal(ops(s), "base l4; off 12; read 2");
  assert.deepEqual(s.decode, { kind: "uint", size: 2, bitfield: { bit_offset: 9, bit_size: 1 } });
  const u = await one(ROOTS.udp, "ulen");
  assert.equal(ops(u), "base l4; off 4; read 2");
  const x = await one(ROOTS.xdp, "ip.protocol");
  assert.equal(ops(x), "base l3; off 9; read 1");
});

test("payload reads through the skb on tcx and the head elsewhere", async () => {
  const t = await one(tcp, "req: payload(0, 64, text)");
  assert.equal(ops(t), "base payload; skb 64");
  assert.deepEqual(t.decode, { kind: "text", size: 64, payload: 0 });
  const x = await one(ROOTS.xdp, "req: payload(8, 32, bytes)");
  assert.equal(ops(x), "base payload; off 8; read 32");
  const h = await one(ROOTS.https, "line: payload(0, 80, text)");
  assert.equal(ops(h), "base payload; read 80");
});

test("arithmetic goes through scratch; a register's value is a val", async () => {
  const f = await one(tcp, "inflight: sndNxt - sndUna");
  assert.equal(ops(f), "base sk; off 1720; loadn 4; store; base sk; off 1716; loadn 4; sub; val 4");
  assert.deepEqual(f.decode, { kind: "uint", size: 4 });
  const g = await one(tcp, "next: cwnd + 1");
  assert.equal(ops(g), "base sk; off 1492; loadn 4; off 1; val 4");
  const s = await one(ROOTS.https, "ssl()");
  assert.equal(ops(s), "base ctx; val 8");
  assert.equal(s.name, "ssl");
});

test("a bitfield needs an integer kind; the limits hold", async () => {
  await assert.rejects(one(tcp, "syn(str)"), /bitfield/);
  await assert.rejects(compileFields(btf, tcp, []), /at least one/);
  await assert.rejects(compileFields(btf, tcp, parseSelect(tcp, "cwnd, cwnd")), /twice/);
  await assert.rejects(one(tcp, "sock.nothing"), /no member nothing/);
});
