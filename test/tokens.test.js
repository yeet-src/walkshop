import assert from "node:assert/strict";
import { test } from "node:test";

import { lines, tokenize } from "../app/lib/gql/tokens.js";

const kinds = (text) => tokenize(text).filter((t) => t.kind !== "space" && t.kind !== "punct").map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);

test("names are classified by where they stand", () => {
  assert.deepEqual(kinds(`{ tcp(ports: [80], data: true) { hook c: cwnd @when(gt: 10) tcphdr { window } req: payload(len: 32, kind: text) } }`), [
    "root:tcp", "arg:ports", "number:80", "arg:data", "value:true",
    "leaf:hook", "alias:c", "leaf:cwnd", "directive:when", "arg:gt", "number:10",
    "base:tcphdr", "leaf:window",
    "alias:req", "base:payload", "arg:len", "number:32", "arg:kind", "value:text",
  ]);
  assert.deepEqual(kinds(`query { struct(name: "tcp_sock") { members { name } } }`), ["keyword:query", "root:struct", "arg:name", 'string:"tcp_sock"', "base:members", "leaf:name"]);
});

test("the scanner never throws; a bad character is an error token; comments and half strings hold", () => {
  assert.deepEqual(kinds("{ tcp { a $ b } } # note"), ["root:tcp", "leaf:a", "error:$", "leaf:b", "comment:# note"]);
  assert.deepEqual(kinds('{ tcp(iface: "wl'), ["root:tcp", "arg:iface", 'string:"wl']);
  const all = tokenize("{ tcp { a } }");
  assert.equal(all[all.length - 1].end, "{ tcp { a } }".length, "tokens cover the text");
});

test("lines split tokens at newlines and keep empty lines", () => {
  const rows = lines("{ tcp {\n\n  cwnd\n} }");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[2].map((t) => t.text), ["  ", "cwnd"]);
});
