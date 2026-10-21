/* The query, printed the one way: two-space indent, one field per
 * line, arguments and directives inline, a selection set opening on
 * the field's line. Parses first, so a query that does not parse is
 * left alone and the error says why. Comments are not kept — the tree
 * has no place for them. A pipeline tail is kept as written, each
 * stage on its own `| name {` line with its body re-indented. Pure,
 * browser-safe. */

import { parse } from "./parse.js";

const INDENT = "  ";

function value(v) {
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  return String(v);
}

/* A bare name that reached the parser as a string is an enum-ish
 * value (`proto: tcp`, `kind: text`); it was parsed as a name and
 * arrives as a string indistinguishable from a quoted one. Print the
 * ones that are valid names bare only for the arguments that take
 * enums, and quote the rest. */
const ENUM_ARGS = new Set(["kind", "proto"]);

function args(a) {
  const keys = Object.keys(a);
  if (!keys.length) return "";
  return `(${keys.map((k) => `${k}: ${ENUM_ARGS.has(k) && typeof a[k] === "string" && /^[A-Za-z_][\w:]*$/.test(a[k]) ? a[k] : value(a[k])}`).join(", ")})`;
}

function field(f, depth) {
  const pad = INDENT.repeat(depth);
  let line = `${pad}${f.alias ? `${f.alias}: ` : ""}${f.name}${args(f.args)}`;
  for (const d of f.directives) line += ` @${d.name}${args(d.args)}`;
  if (f.selections) {
    if (!f.selections.length) return `${line} { }`;
    return `${line} {\n${f.selections.map((s) => field(s, depth + 1)).join("\n")}\n${pad}}`;
  }
  return line;
}

/** The query text, formatted. Throws a QueryError with a line if it does not parse. */
export function format(text) {
  const sels = parse(text);
  const head = `{\n${sels.map((s) => field(s, 1)).join("\n")}\n}`;
  const tail = (sels.stages ?? []).map((st) => {
    const body = st.src.replace(/^\s*\n|\s+$/g, "").split("\n");
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length), 1e9);
    const lines = body.map((l) => (l.trim() ? INDENT + l.slice(Number.isFinite(indent) ? indent : 0) : ""));
    return `| ${st.name} {\n${lines.join("\n")}\n}`;
  });
  return `${[head, ...tail].join("\n")}\n`;
}
