/* The pipeline tail: JavaScript over the rows, after the selection.
 *
 *   { tcp(ports: [80]) { hook daddr len } }
 *   | context   { let n = 0; const seen = new Set(); }   # once, when the run starts
 *   | transform { $.n = ++n; if ($.len === 0) return null; }   # per row
 *
 * `$` is the row as the selection shaped it — prefix columns on top,
 * bases nested — and `root` the root it came from. Mutate `$` in
 * place, `return` a new object to reshape the row (its keys become the
 * columns), or `return null` to drop it. What `context` declares is in
 * scope for every transform and lives for the run; several transforms
 * chain in order. The kernel still captures only what was selected;
 * this runs in the isolate, over the decoded stream.
 *
 * The GraphQL lexer cannot see JavaScript, so the tail is split off
 * before lexing: the head ends at the close of the document's
 * top-level brace group (by GraphQL rules), then each `| name { … }`
 * is brace-matched with JavaScript rules — strings, template literals
 * with nested `${}`, both comment forms. A regex literal is not
 * tracked; a `}` inside one would end the block early. Pure. */

import { fail } from "./lex.js";

const STAGES = new Set(["context", "transform"]);

function scanTemplate(text, start, line) {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === "\n") {
      line++;
      i++;
    } else if (c === "`") return { i: i + 1, line };
    else if (c === "$" && text[i + 1] === "{") {
      const r = scanJsBraces(text, i + 1, line);
      i = r.i;
      line = r.line;
    } else i++;
  }
  return { i, line };
}

function scanJsBraces(text, start, line0) {
  let i = start + 1;
  let line = line0;
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i = Math.min(i + 2, text.length);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      const r = scanTemplate(text, i, line);
      i = r.i;
      line = r.line;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
      if (!depth) return { i, line };
    } else i++;
  }
  fail(line0, "unclosed JavaScript block");
}

/** `{ head, stages: [{ name, src, line }] }` — the GraphQL and the tail. */
export function splitPipeline(text) {
  const src = String(text ?? "");
  let i = 0;
  let line = 1;
  let depth = 0;
  let started = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") line++;
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (c === "{") {
      depth++;
      started = true;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
      if (started && depth === 0) break;
    } else i++;
  }
  const head = src.slice(0, i);
  const ws = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === " " || c === "\t" || c === "\r" || c === ",") i++;
      else if (c === "#") {
        while (i < src.length && src[i] !== "\n") i++;
      } else break;
    }
  };
  const stages = [];
  ws();
  while (i < src.length) {
    if (src[i] !== "|") fail(line, "expected `|` or the end of the query after the selection set");
    i++;
    ws();
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (!m) fail(line, "expected a stage name after `|`: context or transform");
    if (!STAGES.has(m[0])) fail(line, `unknown pipeline stage \`${m[0]}\`; have context, transform`);
    i += m[0].length;
    ws();
    if (src[i] !== "{") fail(line, `\`${m[0]}\` wants a { … } block of JavaScript`);
    const at = line;
    const r = scanJsBraces(src, i, line);
    stages.push({ name: m[0], src: src.slice(i + 1, r.i - 1), line: at });
    i = r.i;
    line = r.line;
    ws();
  }
  return { head, stages };
}

/**
 * Compile the stages: `context` sources become the factory's body,
 * evaluated once per `create()`; each `transform` a `($, root) => { … }`
 * closing over it. Each stage is checked on its own first, so a syntax
 * error blames the right block. Returns null for no stages.
 */
export function buildPipeline(stages) {
  if (!stages?.length) return null;
  for (const s of stages) {
    try {
      if (s.name === "context") new Function(`"use strict";\n${s.src}`);
      else new Function("$", "root", `"use strict";\n${s.src}`);
    } catch (e) {
      fail(s.line, `${s.name} block: ${e?.message ?? e}`);
    }
  }
  const context = stages.filter((s) => s.name === "context").map((s) => s.src);
  const arms = stages.filter((s) => s.name === "transform").map((s) => `($, root) => {\n${s.src}\n}`);
  let factory;
  try {
    factory = new Function(`"use strict";\n${context.join("\n")}\nreturn [${arms.join(", ")}];`);
  } catch (e) {
    fail(stages[0].line, `pipeline: ${e?.message ?? e}`);
  }
  return {
    stages,
    /** A fresh run of the pipeline: `(row, root) => row | null`. */
    create() {
      const fns = factory();
      return (row, root) => {
        let $ = row;
        for (const fn of fns) {
          const out = fn($, root);
          if (out === null || out === false) return null;
          if (out !== undefined) $ = out;
        }
        return typeof $ === "object" && $ !== null ? $ : { value: $ };
      };
    },
  };
}
