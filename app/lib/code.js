/* Highlighting for the code this app shows: a shell line, a query, a
 * block's JavaScript, JSON. One token shape, `{ kind, text }`, and one
 * class map, so every place that shows code colours it the same way.
 *
 * The shell scanner is for curl lines: the command, its flags, its
 * strings — and inside a string that is a query or JSON, that language,
 * so a `-d '{ tcp { … } }'` reads like the query it is. Pure,
 * browser-safe. */

import { tokenizeJs } from "./chat/js.js";
import { tokenize as tokenizeGql } from "./gql/tokens.js";

export const CODE_CLASS = {
  /* shared */
  comment: "text-dim italic",
  string: "text-green",
  number: "text-cyan",
  keyword: "text-magenta",
  punct: "text-dim",
  plain: "text-fg",
  space: "",
  error: "bg-red text-bg",
  /* js */
  literal: "text-cyan",
  global: "text-yellow",
  prop: "text-blue",
  type: "text-fg",
  ident: "text-fg",
  /* graphql */
  root: "text-magenta",
  base: "text-blue",
  leaf: "text-fg",
  alias: "text-cyan",
  arg: "text-dim",
  value: "text-green",
  directive: "text-yellow",
  stage: "text-yellow",
  /* shell */
  command: "text-yellow",
  flag: "text-cyan",
  url: "text-blue underline decoration-dotted",
  /* json */
  key: "text-blue",
};

const LANG = {
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  graphql: "graphql", gql: "graphql", query: "graphql",
  js: "js", javascript: "js", mjs: "js", ts: "js",
  json: "json",
};

/** The language a fence or caller named, normalised; null for plain text. */
export const langOf = (name) => LANG[String(name ?? "").trim().toLowerCase()] ?? null;

function graphql(text) {
  const out = [];
  for (const t of tokenizeGql(text)) {
    const piece = text.slice(t.start, t.end);
    if (t.kind === "js") for (const j of tokenizeJs(piece)) out.push({ kind: j.kind, text: j.text });
    else out.push({ kind: t.kind, text: piece });
  }
  return out;
}

function json(text) {
  const out = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)|(.)/gi;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] != null) {
      out.push({ kind: m[2] ? "key" : "string", text: m[1] });
      if (m[2]) out.push({ kind: "punct", text: m[2] });
    } else if (m[3] != null) out.push({ kind: "number", text: m[3] });
    else if (m[4] != null) out.push({ kind: "literal", text: m[4] });
    else if (m[5] != null) out.push({ kind: "punct", text: m[5] });
    else if (m[6] != null) out.push({ kind: "space", text: m[6] });
    else out.push({ kind: "plain", text: m[7] });
  }
  return out;
}

/* A quoted shell string's contents, highlighted as what they are. */
function inString(body) {
  const t = body.trim();
  if (/^(https?|wss?):\/\/\S+$/.test(t)) return [{ kind: "url", text: body }];
  if (/^\{\s*"/.test(t)) return json(body);
  if (/^\{/.test(t) || /^(query|subscription)\b/.test(t)) return graphql(body);
  return [{ kind: "string", text: body }];
}

function shell(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    if (li) out.push({ kind: "space", text: "\n" });
    let i = 0;
    let first = true; /* the next bare word is the command */
    while (i < line.length) {
      const rest = line.slice(i);
      let m;
      if ((m = /^\s+/.exec(rest))) {
        out.push({ kind: "space", text: m[0] });
      } else if ((m = /^#.*$/.exec(rest))) {
        out.push({ kind: "comment", text: m[0] });
      } else if ((m = /^'([^']*)'/.exec(rest))) {
        out.push({ kind: "punct", text: "'" });
        out.push(...inString(m[1]));
        out.push({ kind: "punct", text: "'" });
      } else if ((m = /^"((?:[^"\\]|\\.)*)"/.exec(rest))) {
        out.push({ kind: "punct", text: '"' });
        out.push(...inString(m[1]));
        out.push({ kind: "punct", text: '"' });
      } else if ((m = /^(\|\||&&|\||;|\\$)/.exec(rest))) {
        out.push({ kind: "punct", text: m[0] });
        first = true;
      } else if ((m = /^--?[\w-]+(=[^\s'"]*)?/.exec(rest))) {
        out.push({ kind: "flag", text: m[0] });
      } else if ((m = /^(https?:\/\/|wss?:\/\/)[^\s'"]+/.exec(rest))) {
        out.push({ kind: "url", text: m[0] });
      } else if ((m = /^[^\s'"|;&\\]+/.exec(rest))) {
        out.push({ kind: first ? "command" : "plain", text: m[0] });
        first = false;
      } else {
        out.push({ kind: "plain", text: rest[0] });
        m = [rest[0]];
      }
      i += m[0].length;
    }
  });
  return out;
}

/** `[{ kind, text }]` for `text` in `lang` (a fence name or null). */
export function highlight(lang, text) {
  const src = String(text ?? "");
  switch (langOf(lang)) {
    case "sh":
      return shell(src);
    case "graphql":
      return graphql(src);
    case "js":
      return tokenizeJs(src).map((t) => ({ kind: t.kind, text: t.text }));
    case "json":
      return json(src);
    default:
      return [{ kind: "plain", text: src }];
  }
}
