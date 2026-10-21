import assert from "node:assert/strict";
import { test } from "node:test";

import { header, line, table } from "../app/lib/gql/markdown.js";

test("a markdown table: header from columns, one line per row, cells kept to one line", () => {
  const cols = [{ key: "hook" }, { key: "req" }, { key: "n" }];
  assert.equal(header(cols), "| hook | req | n |\n|---|---|---|");
  assert.equal(line({ hook: "tx", req: "GET / HTTP/1.1\r\nHost: a|b", n: null }, cols), "| tx | GET / HTTP/1.1⏎Host: a\\|b |  |");
  assert.equal(table([{ hook: "rx", req: "x", n: 1 }], ["hook", "n"]), "| hook | n |\n|---|---|\n| rx | 1 |");
});
