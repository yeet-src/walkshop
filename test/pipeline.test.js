import assert from "node:assert/strict";
import { test } from "node:test";

import { format } from "../app/lib/gql/format.js";
import { parse } from "../app/lib/gql/parse.js";
import { buildPipeline, splitPipeline } from "../app/lib/gql/pipeline.js";
import { plan } from "../app/lib/gql/plan.js";
import { tokenize } from "../app/lib/gql/tokens.js";

const q = `{ tcp(ports: [80]) { hook daddr len } }
| context { let n = 0; const seen = new Set(); }
| transform { $.n = ++n; if ($.len === 0) return null; seen.add($.daddr); $.peers = seen.size; }`;

test("the tail splits off by JavaScript rules and the head still parses", () => {
  const { head, stages } = splitPipeline(q);
  assert.equal(head.trim(), "{ tcp(ports: [80]) { hook daddr len } }");
  assert.deepEqual(stages.map((s) => s.name), ["context", "transform"]);
  assert.equal(stages[1].line, 3);
  const tricky = splitPipeline("{ tcp { a } } | transform { const s = \"}\"; const t = `${ {a:1}.a }`; /* } */ $.x = 1 }");
  assert.equal(tricky.stages.length, 1);
  assert.throws(() => splitPipeline("{ tcp { a } } | transform { "), /unclosed JavaScript/);
  assert.throws(() => splitPipeline("{ tcp { a } } | nope { }"), /unknown pipeline stage/);
  assert.equal(parse(q).stages.length, 2);
});

test("a pipeline keeps context across rows, reshapes, and drops", () => {
  const p = buildPipeline(splitPipeline(q).stages);
  const run = p.create();
  assert.deepEqual(run({ hook: "tx", daddr: "1.1.1.1", len: 10 }, "tcp"), { hook: "tx", daddr: "1.1.1.1", len: 10, n: 1, peers: 1 });
  assert.equal(run({ hook: "tx", daddr: "1.1.1.1", len: 0 }, "tcp"), null);
  assert.deepEqual(run({ hook: "rx", daddr: "2.2.2.2", len: 5 }, "tcp").peers, 2);
  const again = p.create();
  assert.equal(again({ hook: "tx", daddr: "9.9.9.9", len: 1 }, "tcp").n, 1, "a fresh create() is a fresh context");
  const reshape = buildPipeline(splitPipeline("{ tcp { a } } | transform { return { who: $.daddr, root } }").stages).create();
  assert.deepEqual(reshape({ daddr: "3.3.3.3" }, "tcp"), { who: "3.3.3.3", root: "tcp" });
  assert.throws(() => buildPipeline([{ name: "transform", src: "this is not js", line: 4 }]), /transform block/);
});

test("plan carries the pipeline; format keeps the tail; tokens mark it", () => {
  const p = plan(q);
  assert.ok(p.pipeline);
  assert.equal(p.stages.length, 2);
  const out = format(q);
  assert.ok(out.includes("| context {\n  let n = 0; const seen = new Set();\n}"));
  assert.ok(out.startsWith("{\n  tcp(ports: [80]) {"));
  assert.equal(format(out), out);
  const kinds = tokenize(q).map((t) => t.kind);
  assert.ok(kinds.includes("stage") && kinds.includes("js"));
  assert.equal(tokenize(q).at(-1).end, q.length, "tokens cover the text");
});

test("payload defaults to auto, and auto tells text from bytes", async () => {
  const { looksText } = await import("../app/lib/hex.js");
  const p = plan("{ tcp { req: payload() } }");
  assert.equal(p.roots[0].entries[0].term.as, "auto");
  assert.equal(p.roots[0].entries[0].term.len, 1024);
  const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  assert.ok(looksText(hex("GET / HTTP/1.1\r\nHost: x\r\n\r\n")));
  assert.ok(!looksText("16030100f5010000f10303" + "00".repeat(40)));
  assert.ok(!looksText(""));
});

test("a block being written parses as open source, a closed one as a block", async () => {
  const { parseBlocks } = await import("../app/lib/chat/blocks.js");
  const streaming = parseBlocks("Two peers.\n\n:::lineChart{live=1000}\nconst d = await query(");
  assert.deepEqual(streaming.map((s) => s.t), ["md", "open"]);
  assert.equal(streaming[1].name, "lineChart");
  assert.equal(streaming[1].src, "const d = await query(");
  const closed = parseBlocks("Two peers.\n\n:::lineChart{live=1000}\nconst d = 1;\n:::\n");
  assert.deepEqual(closed.map((s) => s.t), ["md", "block", "md"]);
  assert.equal(closed[1].attrs.live, 1000);
});
