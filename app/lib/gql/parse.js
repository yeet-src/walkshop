/* The query's shape, as a tree.
 *
 *   document := ("query" | "subscription")? name? selectionSet
 *   field    := name (":" name)? args? ("@" name args?)* selectionSet?
 *   args     := "(" (name ":" value)* ")"
 *   value    := Int | String | true | false | name | "[" value* "]"
 *
 * No variables, no fragments: an agent writes a query whole. A field
 * is `{ name, alias, args, directives, selections, line }`. A pipeline
 * tail (`| transform { … }`, pipeline.js) is split off first and comes
 * back as `stages` on the result. Pure. */

import { fail, lex } from "./lex.js";
import { splitPipeline } from "./pipeline.js";

export function parse(text) {
  const { head, stages } = splitPipeline(String(text ?? ""));
  const sels = parseHead(head);
  sels.stages = stages;
  return sels;
}

function parseHead(text) {
  const toks = lex(String(text ?? ""));
  let i = 0;

  const peek = () => toks[i];
  const lineAt = () => toks[i]?.line ?? toks[toks.length - 1]?.line ?? 1;
  const eat = (t) => (toks[i]?.t === t ? toks[i++] : null);
  const expect = (t, what) => eat(t) ?? fail(lineAt(), `expected ${what ?? `\`${t}\``}${peek() ? `, got \`${peek().v ?? peek().t}\`` : " at the end"}`);

  function value() {
    const tok = toks[i++];
    if (!tok) fail(lineAt(), "expected a value");
    if (tok.t === "int" || tok.t === "str") return tok.v;
    if (tok.t === "name") return tok.v === "true" ? true : tok.v === "false" ? false : tok.v === "null" ? null : tok.v;
    if (tok.t === "[") {
      const out = [];
      while (!eat("]")) {
        if (!peek()) fail(lineAt(), "unclosed list");
        out.push(value());
      }
      return out;
    }
    fail(tok.line, `expected a value, got \`${tok.t}\``);
  }

  function args() {
    if (!eat("(")) return {};
    const out = {};
    while (!eat(")")) {
      const name = expect("name", "an argument name");
      expect(":");
      out[name.v] = value();
    }
    return out;
  }

  function field() {
    const first = expect("name", "a field name");
    let alias = null;
    let name = first.v;
    if (eat(":")) {
      alias = first.v;
      name = expect("name", "a field name after the alias").v;
    }
    const a = args();
    const directives = [];
    while (eat("@")) {
      const d = expect("name", "a directive name");
      directives.push({ name: d.v, args: args(), line: d.line });
    }
    const selections = peek()?.t === "{" ? selectionSet() : null;
    return { name, alias, args: a, directives, selections, line: first.line };
  }

  function selectionSet() {
    expect("{", "`{`");
    const out = [];
    while (!eat("}")) {
      if (!peek()) fail(lineAt(), "unclosed selection set");
      out.push(field());
    }
    return out;
  }

  if (peek()?.t === "name" && (peek().v === "query" || peek().v === "subscription")) {
    i++;
    eat("name");
  }
  if (!peek()) fail(1, "empty query");
  const sels = selectionSet();
  if (peek()) fail(lineAt(), `unexpected \`${peek().v ?? peek().t}\` after the selection set`);
  return sels;
}
