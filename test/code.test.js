import assert from "node:assert/strict";
import { test } from "node:test";

import { highlight, langOf } from "../app/lib/code.js";

const kinds = (lang, text) => highlight(lang, text).filter((t) => t.kind !== "space").map((t) => `${t.kind}:${t.text}`);

test("a curl line: command, flags, url, and the query inside the string as a query", () => {
  const k = kinds("sh", `curl -sN 'http://goofy:3600/api/query?stream=1' -H 'content-type: application/graphql' -d '{ tcp(data: true) { hook } }'`);
  assert.equal(k[0], "command:curl");
  assert.equal(k[1], "flag:-sN");
  assert.ok(k.includes("url:http://goofy:3600/api/query?stream=1"), "a url inside quotes");
  assert.ok(k.includes("string:content-type: application/graphql"), "a plain string stays a string");
  assert.ok(k.includes("root:tcp") && k.includes("leaf:hook"), "the query inside -d is coloured as a query");
  assert.deepEqual(kinds("sh", "# a comment\nls | wc -l").slice(0, 4), ["comment:# a comment", "command:ls", "punct:|", "command:wc"]);
});

test("json keys, strings, numbers and literals; an unknown language is plain", () => {
  assert.deepEqual(kinds("json", '{ "a": 1, "b": "x", "c": null }').filter((k) => !k.startsWith("punct")), ["key:\"a\"", "number:1", "key:\"b\"", "string:\"x\"", "key:\"c\"", "literal:null"]);
  assert.deepEqual(kinds("", "anything"), ["plain:anything"]);
  assert.equal(langOf("Bash"), "sh");
  assert.equal(langOf("nope"), null);
  assert.ok(kinds("graphql", "{ tcp { cwnd } } | transform { $.cwnd }").includes("root:tcp"));
});
