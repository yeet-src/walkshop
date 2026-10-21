/* The select front-end: one string per column, the quickest way to ask.
 *
 *   entry := [name ":"] expr
 *   expr  := term | term ("+" | "-") term
 *   term  := INT
 *          | path ["(" kind ["," size] ")"]
 *          | "payload" "(" offset "," len ["," kind] ")"
 *          | base ".at" "(" offset "," len ["," kind] ")"
 *          | reg "(" ")"                      the register's value
 *   path  := base "." member ("." member)*  |  alias
 *
 * Parses into the terms emit.js compiles. Pure. */

import { REG } from "./ops.js";
import { splitPath } from "../roots.js";
import { KINDS } from "./resolve.js";

function lex(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if ("():,+-.".includes(c)) toks.push({ t: c }), i++;
    else {
      let m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "name", v: m[0] });
        i += m[0].length;
        continue;
      }
      m = /^(0x[0-9a-fA-F]+|\d+)/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "int", v: parseInt(m[0], m[0].startsWith("0x") ? 16 : 10) });
        i += m[0].length;
        continue;
      }
      throw new Error(`unexpected character \`${c}\``);
    }
  }
  return toks;
}

/** `{ name, term }` for one entry against `root`. */
export function parseEntry(root, text) {
  const toks = lex(text);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t) => {
    const k = next();
    if (!k || k.t !== t) throw new Error(`expected \`${t}\`${k ? `, got \`${k.v ?? k.t}\`` : " at the end"}`);
    return k;
  };

  let name = null;
  if (toks[0]?.t === "name" && toks[1]?.t === ":") {
    name = toks[0].v;
    i = 2;
  }

  const kindArg = () => {
    const k = expect("name").v;
    if (k === "json") {
      expect(":");
      return `json:${expect("name").v}`;
    }
    if (!KINDS.has(k) || k === "enum") throw new Error(`unknown kind \`${k}\``);
    return k;
  };

  const window = (defaultKind) => {
    expect("(");
    const offset = expect("int").v;
    expect(",");
    const len = expect("int").v;
    let kind = defaultKind;
    if (peek()?.t === ",") {
      next();
      kind = kindArg();
    }
    expect(")");
    return { offset, len, kind };
  };

  const term = () => {
    const k = next();
    if (!k) throw new Error("expected a field");
    if (k.t === "int") return { kind: "int", value: k.v };
    if (k.t !== "name") throw new Error(`expected a field, got \`${k.t}\``);
    const parts = [k.v];
    while (peek()?.t === ".") {
      next();
      parts.push(expect("name").v);
    }
    if (parts.length === 1 && parts[0] === "payload") {
      const w = window("auto");
      return { kind: "raw", reg: root.payload, offset: w.offset, len: w.len, as: w.kind, ...(root.skb ? { skb: true } : {}) };
    }
    if (parts.length === 2 && parts[1] === "at") {
      const base = root.bases[parts[0]];
      if (!base) throw new Error(`unknown base \`${parts[0]}\``);
      const w = window("bytes");
      return { kind: "raw", reg: base.reg, offset: w.offset, len: w.len, as: w.kind, ...(base.needs ? { needs: base.needs } : {}) };
    }
    if (parts.length === 1 && peek()?.t === "(" && toks[i + 1]?.t === ")" && root.bases[parts[0]]) {
      next();
      next();
      return { kind: "reg", reg: root.bases[parts[0]].reg, as: "ptr" };
    }
    const { base, members } = splitPath(root, parts.join("."));
    const out = { kind: "path", base, members, as: null, size: null, alias: parts.length === 1 && root.aliases[parts[0]] ? parts[0] : null };
    if (peek()?.t === "(") {
      next();
      out.as = kindArg();
      if (peek()?.t === ",") {
        next();
        out.size = expect("int").v;
      }
      expect(")");
    }
    return out;
  };

  const a = term();
  let expr = a;
  if (peek()?.t === "+" || peek()?.t === "-") {
    const sign = next().t;
    const b = term();
    expr = { kind: "arith", sign, a, b };
  }
  if (i < toks.length) throw new Error(`unexpected \`${toks[i].v ?? toks[i].t}\``);
  if (expr.kind === "int") throw new Error("a number alone is not a field");
  return { name: name ?? defaultName(text, expr), term: expr };
}

const defaultName = (text, expr) => {
  if (expr.kind === "path") return expr.alias ?? (expr.members.length ? expr.members[expr.members.length - 1] : expr.base);
  if (expr.kind === "raw") return "payload";
  if (expr.kind === "reg") return text.replace(/\(\)\s*$/, "").trim();
  return null;
};

/** Parse a comma-separated select (commas inside parens are kept) into entries. */
export function parseSelect(root, text) {
  return String(text)
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((source) => ({ ...parseEntry(root, source), source }));
}
