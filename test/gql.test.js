import assert from "node:assert/strict";
import { test } from "node:test";

import { parse } from "../app/lib/gql/parse.js";
import { passes, plan } from "../app/lib/gql/plan.js";
import { DOCS, SDL } from "../app/lib/gql/schema.js";
import { columnsOf, flatten, shapeRow } from "../app/lib/gql/shape.js";
import { ROOTS } from "../app/lib/roots.js";
import { compileFields } from "../app/lib/vm/emit.js";
import { listing } from "../app/lib/vm/ops.js";
import { btf } from "./btf-stub.js";

const ops = (f) => listing([...f.pre, ...f.body]);

test("parse: aliases, args, lists, directives, nesting, comments", () => {
  const sels = parse(`
    # a comment
    query { tcp(ports: [80, 443], data: true, iface: "lo") {
      hook
      c: cwnd @when(gt: 10)
      sock { sk_dst_cache { dev { name } } }
    } }`);
  assert.equal(sels.length, 1);
  const t = sels[0];
  assert.equal(t.name, "tcp");
  assert.deepEqual(t.args, { ports: [80, 443], data: true, iface: "lo" });
  assert.equal(t.selections[1].alias, "c");
  assert.deepEqual(t.selections[1].directives[0], { name: "when", args: { gt: 10 }, line: 5 });
  assert.equal(t.selections[2].selections[0].selections[0].name, "dev");
  assert.throws(() => parse("{ tcp { "), /unclosed/);
  assert.equal(parse("{ tcp { a } } | transform { }").stages.length, 1);
  assert.throws(() => parse(""), /empty/);
});

test("plan: prefix columns are free, aliases and bases are VM entries, args are checked", () => {
  const p = plan(`{ tcp(ports: [80], limit: 5, ms: 100) { hook comm dport cwnd tcp { rx_opt { ts_recent } } req: payload(len: 32, kind: text) } }`);
  assert.equal(p.roots.length, 1);
  const r = p.roots[0];
  assert.deepEqual(r.columns, ["hook", "comm", "dport"]);
  assert.deepEqual(r.args, { limit: 5, ms: 100, every: 0, ports: [80], data: false });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    ["cwnd", "tcp.rx_opt.ts_recent", "req"],
  );
  assert.deepEqual(r.entries[1].term, { kind: "path", base: "tcp", members: ["rx_opt", "ts_recent"], as: null, size: null });
  assert.deepEqual(r.layout.tcp, { kind: "object", fields: { rx_opt: { kind: "object", fields: { ts_recent: { kind: "vm", name: "tcp.rx_opt.ts_recent" } } } } });
  assert.throws(() => plan("{ tcp(bogus: 1) { hook } }"), /no argument `bogus`/);
  assert.throws(() => plan("{ tcp { nope } }"), /not on tcp/);
  assert.throws(() => plan("{ tcp { sock } }"), /select its members/);
  assert.throws(() => plan("{ xdp { hook } }"), /needs iface/);
  assert.throws(() => plan("{ nope { x } }"), /unknown root/);
  assert.throws(() => plan("{ tcp { cwnd cwnd } }"), /twice/);
  assert.throws(() => plan(`{ tcp { ${"a1 a2 a3 a4 a5 a6 a7 a8 a9".split(" ").map((a) => `${a}: cwnd`).join(" ")} } }`), /8 per root/);
});

test("plan: directives become gates, arithmetic and masks; @when on a prefix column is a host filter", () => {
  const p = plan(`{ tcp {
    hook @when(eq: "tx")
    inflight: sndNxt @minus(field: "sndUna")
    https: tcphdr { dest @when(eq: 443) }
    big: cwnd @when(gt: 10)
    flags: tcphdr { doff @and(mask: 15) @shr(bits: 4) }
  } }`);
  const r = p.roots[0];
  assert.deepEqual(r.filters, [{ column: "hook", op: "eq", value: "tx" }]);
  const [inflight, dest, big, doff] = r.entries;
  assert.equal(inflight.term.kind, "arith");
  assert.deepEqual(inflight.term.b.members, ["snd_una"]);
  assert.equal(dest.term.kind, "gate");
  assert.deepEqual(dest.term.cond, { term: { kind: "path", base: "tcphdr", members: ["dest"], as: null, size: null }, op: "eq", imm: 443 });
  assert.equal(big.term.cond.op, "gt");
  assert.deepEqual(doff.term, { kind: "mask", term: { kind: "path", base: "tcphdr", members: ["doff"], as: null, size: null }, and: 15, shr: 4 });
  assert.throws(() => plan("{ tcp { cwnd @nope } }"), /unknown directive/);
  assert.throws(() => plan("{ tcp { hook @minus(field: \"x\") } }"), /does not apply/);
  assert.ok(passes({ hook: "tx" }, r.filters));
  assert.ok(!passes({ hook: "rx" }, r.filters));
});

test("compile a plan: the gate byte-swaps a big-endian immediate and skips the term", async () => {
  const p = plan(`{ tcp { https: tcphdr { dest @when(eq: 443) } inflight: sndNxt @minus(field: "sndUna") } }`);
  const fields = await compileFields(btf, ROOTS.tcp, p.roots[0].entries);
  assert.equal(ops(fields[0]), `base l4; off 2; loadn 2; eq ${0xbb01}; skipz 3; base l4; off 2; read 2`);
  assert.deepEqual(fields[0].decode, { kind: "be", size: 2 });
  assert.equal(ops(fields[1]), "base sk; off 1720; loadn 4; store; base sk; off 1716; loadn 4; sub; val 4");
  assert.equal(fields[1].pre.length + fields[1].body.length, 9, "nine ops split across pre and body");
});

test("shape: rows nest as the selection does; flatten walks the columns", () => {
  const p = plan(`{ tcp { hook c: cwnd sock { sk_dst_cache { dev { name } } } } }`);
  const row = { hook: "tx", values: { c: 10, "sock.sk_dst_cache.dev.name": "lo" } };
  const shaped = shapeRow(row, p.roots[0].layout);
  assert.deepEqual(shaped, { hook: "tx", c: 10, sock: { sk_dst_cache: { dev: { name: "lo" } } } });
  const cols = columnsOf(p.roots[0].layout);
  assert.deepEqual(cols.map((c) => c.key), ["hook", "c", "sock.sk_dst_cache.dev.name"]);
  assert.deepEqual(flatten(shaped, cols), { hook: "tx", c: 10, "sock.sk_dst_cache.dev.name": "lo" });
});

test("meta roots plan; the docs name every root", () => {
  const p = plan(`{ struct(name: "tcp_sock") { members { name } } roots { name } __schema }`);
  assert.deepEqual(p.meta.map((m) => m.kind), ["struct", "roots", "__schema"]);
  for (const name of Object.keys(ROOTS)) assert.ok(DOCS.includes(`### ${name}`));
  assert.ok(SDL.includes("type Query"));
});

test("plan: a root remembers which args the query wrote, so a stream can lift the defaults", () => {
  assert.deepEqual(plan("{ tcp { hook } }").roots[0].given, []);
  assert.deepEqual(plan("{ tcp(limit: 3) { hook } }").roots[0].given, ["limit"]);
  assert.deepEqual(plan("{ tcp(limit: 3) { hook } }").roots[0].args.ms, 2000);
});
