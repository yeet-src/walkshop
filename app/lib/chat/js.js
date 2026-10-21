/* JavaScript, coloured: a tolerant tokenizer for showing a block's
 * body. Comments, strings, template literals (with their `${}` holes
 * as code), numbers, keywords, the block's own globals, properties
 * after a dot, identifiers, punctuation. Never throws; whatever it
 * cannot place is plain. Also a light tidy: trailing space off, the
 * common indent off. Pure, browser-safe. */

const KEYWORDS = new Set("const let var function return if else for of in while do break continue new await async try catch finally throw class extends this typeof instanceof switch case default import export yield delete void".split(" "));
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const PUNCT = "{}()[];,.<>=+-*/%!&|?:^~";

export function tokenizeJs(src, globals = []) {
  const G = new Set(globals);
  const out = [];
  const s = String(src ?? "");
  let i = 0;
  let prevSig = null; /* the last non-space token, for `.prop` */
  const push = (kind, text) => {
    out.push({ kind, text });
    if (kind !== "space") prevSig = out[out.length - 1];
  };
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < s.length && /[ \t\n\r]/.test(s[j])) j++;
      push("space", s.slice(i, j));
      i = j;
      continue;
    }
    if (two === "//") {
      let j = s.indexOf("\n", i);
      if (j < 0) j = s.length;
      push("comment", s.slice(i, j));
      i = j;
      continue;
    }
    if (two === "/*") {
      let j = s.indexOf("*/", i + 2);
      j = j < 0 ? s.length : j + 2;
      push("comment", s.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
      push("string", s.slice(i, Math.min(j + 1, s.length)));
      i = Math.min(j + 1, s.length);
      continue;
    }
    if (c === "`") {
      /* a template literal: its text as string, each ${…} as code */
      let j = i + 1;
      let start = i;
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$" && s[j + 1] === "{") {
          push("string", s.slice(start, j));
          let depth = 1;
          let k = j + 2;
          while (k < s.length && depth) {
            if (s[k] === "{") depth++;
            else if (s[k] === "}") depth--;
            if (depth) k++;
          }
          push("punct", "${");
          for (const t of tokenizeJs(s.slice(j + 2, k), globals)) out.push(t);
          push("punct", "}");
          j = k + 1;
          start = j;
          continue;
        }
        j++;
      }
      push("string", s.slice(start, Math.min(j + 1, s.length)));
      i = Math.min(j + 1, s.length);
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?n?)/.exec(s.slice(i));
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (id) {
      const w = id[0];
      const afterDot = prevSig?.kind === "punct" && prevSig.text === ".";
      const kind = afterDot ? "prop" : KEYWORDS.has(w) ? "keyword" : LITERALS.has(w) ? "literal" : G.has(w) ? "global" : /^[A-Z]/.test(w) ? "type" : "ident";
      push(kind, w);
      i += w.length;
      continue;
    }
    if (PUNCT.includes(c)) {
      push("punct", c);
      i++;
      continue;
    }
    push("plain", c);
    i++;
  }
  return out;
}

/** Trailing space off every line, the common leading indent off, tabs to two spaces. */
export function tidyJs(src) {
  const lines = String(src ?? "")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(common, /^ */.exec(l)[0].length))).join("\n");
}
