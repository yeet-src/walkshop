/* Tokens of the query language: the GraphQL subset walkshop speaks.
 * Names, integers, strings, the punctuation of selection sets,
 * arguments, lists and directives; `#` comments; commas are
 * whitespace. Every token carries its line, for the errors. Pure. */

export class QueryError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

export const fail = (line, message) => {
  throw new QueryError(line, message);
};

const PUNCT = "{}():@[]|";

export function lex(text) {
  const toks = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r" || c === ",") {
      i++;
    } else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (PUNCT.includes(c)) {
      toks.push({ t: c, line });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\n") line++;
        s += text[j] === "\\" ? text[++j] : text[j];
        j++;
      }
      if (j >= text.length) fail(line, "unterminated string");
      toks.push({ t: "str", v: s, line });
      i = j + 1;
    } else {
      let m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "name", v: m[0], line });
        i += m[0].length;
        continue;
      }
      m = /^-?(0x[0-9a-fA-F]+|\d+)/.exec(text.slice(i));
      if (m) {
        const neg = m[0].startsWith("-");
        const body = neg ? m[0].slice(1) : m[0];
        const v = parseInt(body, body.startsWith("0x") ? 16 : 10);
        toks.push({ t: "int", v: neg ? -v : v, line });
        i += m[0].length;
        continue;
      }
      fail(line, `unexpected character \`${c}\``);
    }
  }
  return toks;
}
