import assert from "node:assert/strict";
import { test } from "node:test";

import { tidyJs, tokenizeJs } from "../app/lib/chat/js.js";

const kinds = (src, g) => tokenizeJs(src, g).filter((t) => t.kind !== "space").map((t) => `${t.kind}:${t.text}`);

test("javascript tokens: keywords, globals, props, strings, templates with holes, numbers, comments", () => {
  assert.deepEqual(kinds(`const d = await query("{ tcp }"); // look\nfor (const r of d.tcp ?? []) lineChart.push(r.daddr, r.srtt / 1000);`, ["lineChart", "query"]), [
    "keyword:const", "ident:d", "punct:=", "keyword:await", "global:query", "punct:(", 'string:"{ tcp }"', "punct:)", "punct:;", "comment:// look",
    "keyword:for", "punct:(", "keyword:const", "ident:r", "keyword:of", "ident:d", "punct:.", "prop:tcp", "punct:?", "punct:?", "punct:[", "punct:]", "punct:)",
    "global:lineChart", "punct:.", "prop:push", "punct:(", "ident:r", "punct:.", "prop:daddr", "punct:,", "ident:r", "punct:.", "prop:srtt", "punct:/", "number:1000", "punct:)", "punct:;",
  ]);
  assert.deepEqual(kinds("`a ${x + 1} b`"), ["string:`a ", "punct:${", "ident:x", "punct:+", "number:1", "punct:}", "string: b`"]);
  assert.equal(tokenizeJs("const s = 'unterminated").at(-1).kind, "string", "never throws");
});

test("tidy strips the common indent and trailing space", () => {
  assert.equal(tidyJs("\n    const a = 1;  \n      b();\n\n"), "const a = 1;\n  b();");
});
