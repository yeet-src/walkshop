/* Tokens for highlighting: the query's lexer, made tolerant.
 *
 * The compiler's lexer stops at the first bad character, which is
 * right for a compiler and wrong for an editor — half-typed text must
 * still colour. So this scanner never throws: an unknown character is
 * an `error` token and scanning goes on. Names are classified by
 * where they stand, the way the planner reads them: a root at the top
 * level, a base when a selection set follows, a directive after `@`,
 * an argument before `:` inside parentheses, a leaf otherwise.
 *
 * Pure, browser-safe: the editor island imports it. */

import { ROOT_NAMES_LIST } from "../roots.js";
import { splitPipeline } from "./pipeline.js";

const ROOTS = new Set([...ROOT_NAMES_LIST, "struct", "roots", "__schema"]);
const KEYWORDS = new Set(["query", "subscription", "true", "false", "null"]);

/** `[{ kind, start, end }]` covering the whole text, in order. */
export function tokenize(text) {
  const src = String(text ?? "");
  /* The tail is JavaScript: `|` and the stage name are the language's,
   * the block is one `js` token. When the tail does not split (an
   * unclosed block while typing) the whole text goes through the
   * GraphQL scanner, which colours what it can. */
  let headEnd = src.length;
  const tail = [];
  try {
    const { head, stages } = splitPipeline(src);
    if (stages.length) {
      headEnd = head.length;
      let at = headEnd;
      for (const st of stages) {
        const bar = src.indexOf("|", at);
        const name = src.indexOf(st.name, bar);
        const brace = src.indexOf("{", name);
        const close = src.indexOf(st.src, brace) + st.src.length;
        if (bar > at) tail.push({ kind: "space", start: at, end: bar });
        tail.push({ kind: "punct", start: bar, end: bar + 1 });
        if (name > bar + 1) tail.push({ kind: "space", start: bar + 1, end: name });
        tail.push({ kind: "stage", start: name, end: name + st.name.length });
        if (brace > name + st.name.length) tail.push({ kind: "space", start: name + st.name.length, end: brace });
        tail.push({ kind: "punct", start: brace, end: brace + 1 });
        tail.push({ kind: "js", start: brace + 1, end: close });
        tail.push({ kind: "punct", start: close, end: close + 1 });
        at = close + 1;
      }
      if (at < src.length) tail.push({ kind: "space", start: at, end: src.length });
    }
  } catch {
    /* scan it all as GraphQL */
  }
  const out = tokenizeHead(src.slice(0, headEnd));
  return out.concat(tail);
}

function tokenizeHead(src) {
  const out = [];
  let i = 0;
  /* Where we are: a stack of "{" (selection depth) and "(" (inside args). */
  const stack = [];
  const inArgs = () => stack[stack.length - 1] === "(";
  const depth = () => stack.filter((s) => s === "{").length;
  let afterAt = false;

  const push = (kind, start, end) => out.push({ kind, start, end });
  const nextNonSpace = (from) => {
    let j = from;
    while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r" || src[j] === "\n" || src[j] === ",")) j++;
    return src[j];
  };

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") {
      let j = i;
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r" || src[j] === "\n" || src[j] === ",")) j++;
      push("space", i, j);
      i = j;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      push("comment", i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      push("string", i, Math.min(j + 1, src.length));
      i = Math.min(j + 1, src.length);
      continue;
    }
    if ("{}()[]:@|".includes(c)) {
      if (c === "{" || c === "(") stack.push(c);
      if (c === "}" || c === ")") stack.pop();
      afterAt = c === "@";
      push("punct", i, i + 1);
      i++;
      continue;
    }
    let m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (m) {
      const end = i + m[0].length;
      let kind = "leaf";
      const next = nextNonSpace(end);
      if (afterAt) kind = "directive";
      else if (KEYWORDS.has(m[0]) && !inArgs() && depth() === 0) kind = "keyword";
      else if (inArgs()) kind = next === ":" ? "arg" : "value";
      else if (next === ":" ) kind = "alias";
      else if (depth() === 1 && ROOTS.has(m[0])) kind = "root";
      else if (next === "{" || next === "(") kind = depth() === 1 && ROOTS.has(m[0]) ? "root" : "base";
      push(kind, i, end);
      afterAt = false;
      i = end;
      continue;
    }
    m = /^-?(0x[0-9a-fA-F]+|\d+)/.exec(src.slice(i));
    if (m) {
      push("number", i, i + m[0].length);
      i += m[0].length;
      continue;
    }
    push("error", i, i + 1);
    i++;
  }
  return out;
}

/** The text split into lines of tokens, so a mirror can draw it line by line. */
export function lines(text) {
  const src = String(text ?? "");
  const toks = tokenize(src);
  const rows = [[]];
  for (const t of toks) {
    let start = t.start;
    const text = src.slice(t.start, t.end);
    const parts = text.split("\n");
    parts.forEach((part, k) => {
      if (k > 0) rows.push([]);
      if (part.length) rows[rows.length - 1].push({ kind: t.kind, text: part, start });
      start += part.length + 1;
    });
  }
  return rows;
}
