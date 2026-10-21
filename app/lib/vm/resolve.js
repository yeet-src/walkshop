/* From a member path to the hops a bounded interpreter takes, by BTF.
 *
 * `yeet:btf`'s walk() resolves `struct.member.member…` into the
 * deref-and-load hops the VM runs, on the running kernel, with this
 * build's offsets — so there is no table of offsets anywhere and no
 * closure of "supported" structs. The member's type decides how its
 * bytes read back, also from BTF: an int's signedness, a __be16/__be32
 * typedef (a port, an address), an enum's names, a char[] (a string),
 * a bitfield's position, struct in6_addr.
 *
 * `btf` is passed in: `yeet:btf` in the isolate, a stub in a test. Its
 * lookups memoize, so a query costs a handful of round trips at most.
 * Pure otherwise. */

import { ENTRY_CAP, MAX_READ } from "./ops.js";

export const KINDS = new Set(["int", "uint", "hex", "ptr", "str", "bool", "ip4", "ip6", "port", "be", "bytes", "text", "auto", "enum", "json", "mac"]);

const isComposite = (k) => k === "struct" || k === "union";

/* The member as declared, found by descending anonymous unions and
 * structs the way a path does. */
async function locate(btf, typeId, name) {
  const t = await btf.expand(typeId);
  for (const m of t.members ?? []) {
    if (m.name === name) return m;
    if (!m.name && isComposite(m.type?.kind)) {
      const found = await locate(btf, m.type.id, name);
      if (found) return found;
    }
  }
  return null;
}

/* The typedef names the path's last member was declared through
 * (`__be16` is how a big-endian field announces itself). */
async function declared(btf, struct, members) {
  try {
    let cur = (await btf.type(struct, { kind: "struct" })).id;
    let member = null;
    for (const name of members) {
      member = await locate(btf, cur, name);
      if (!member) return null;
      const peeled = await btf.peel(member.type.id);
      let t = peeled.type;
      if (t.kind === "ptr" && t.target) t = (await btf.peel(t.target.id)).type;
      cur = t.id;
      if (name === members[members.length - 1]) return { member, typedefs: peeled.typedefs ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

const BE = { __be16: 2, __be32: 4, __be64: 8 };

/* What the bytes of a member are, from its type. */
async function inferDecode(btf, t, typedefs, bitfield) {
  if (bitfield) return { kind: "uint", size: t.size ?? 1, bitfield };
  const be = typedefs.find((n) => BE[n]);
  if (be) return be === "__be32" ? { kind: "ip4", size: 4 } : { kind: "be", size: BE[be] };
  if (typedefs.includes("bool") || t.encoding?.bool) return { kind: "bool", size: t.size ?? 1 };
  switch (t.kind) {
    case "int":
      return { kind: t.encoding?.signed ? "int" : "uint", size: t.size ?? 4 };
    case "enum":
      return { kind: "enum", size: t.size ?? 4, values: Object.fromEntries((t.values ?? []).map((v) => [String(v.value), v.name])) };
    case "ptr":
      return { kind: "ptr", size: 8 };
    case "float":
      return { kind: "hex", size: t.size ?? 8 };
    case "array": {
      const elem = t.elem ? (await btf.peel(t.elem.id).catch(() => ({ type: t.elem }))).type : null;
      const size = (elem?.size ?? 1) * (t.nelems ?? 0);
      if (elem?.kind === "int" && elem.size === 1) {
        if (size === 6) return { kind: "mac", size: 6 };
        return { kind: "str", size: Math.min(size, ENTRY_CAP) };
      }
      return { kind: "bytes", size: Math.min(size || 1, MAX_READ) };
    }
    case "struct":
    case "union":
      if (t.name === "in6_addr") return { kind: "ip6", size: 16 };
      return { kind: "bytes", size: Math.min(t.size || 1, MAX_READ) };
    default:
      throw new Error(`cannot read a ${t.kind}${t.name ? ` (${t.name})` : ""}`);
  }
}

/**
 * Resolve `members` from `struct`: `{ hops, type, bitfield, typedefs,
 * decode }`. `hops` is what the daemon returned — `{ op: "deref" |
 * "load", at, width }` — and `decode` the inferred `{ kind, size, … }`.
 */
export async function resolve(btf, struct, members) {
  if (!members.length) throw new Error(`\`${struct}\` is a struct; name a member of it`);
  let plan;
  try {
    plan = await btf.walk(struct, members.join("."));
  } catch (e) {
    throw new Error(String(e?.message ?? e).replace(/\s+Available members:.*$/s, (m) => m.slice(0, 400)));
  }
  const decl = await declared(btf, struct, members);
  const terminal = await btf.expand(plan.type.id).catch(() => plan.type);
  const decode = await inferDecode(btf, terminal, decl?.typedefs ?? [], plan.bitfield ?? null);
  return { hops: plan.hops, type: terminal, bitfield: plan.bitfield ?? null, typedefs: decl?.typedefs ?? [], decode };
}

/** A struct's members, for introspection: `[{ name, offset, size, type, kind }]`. */
export async function describe(btf, name) {
  const t = await btf.type(name, { kind: "struct" }).catch(() => btf.type(name, { kind: "union" }));
  const full = await btf.expand(t.id);
  const out = [];
  const walk = async (tt, base) => {
    for (const m of tt.members ?? []) {
      const offset = base + (m.offset ?? 0);
      if (!m.name && isComposite(m.type?.kind)) {
        await walk(await btf.expand(m.type.id), offset);
        continue;
      }
      const peeled = await btf.peel(m.type.id).catch(() => ({ type: m.type, typedefs: [] }));
      const tt2 = peeled.type ?? m.type;
      let type = tt2.name ?? tt2.kind;
      if (tt2.kind === "ptr") type = `${tt2.target?.name ?? tt2.target?.kind ?? "void"} *`;
      if (tt2.kind === "array") type = `${tt2.elem?.name ?? "u8"}[${tt2.nelems ?? "?"}]`;
      const decode = await inferDecode(btf, tt2, peeled.typedefs ?? [], m.bitfield ?? null).catch(() => null);
      out.push({
        name: m.name,
        offset,
        size: tt2.size ?? (tt2.kind === "ptr" ? 8 : null),
        type,
        kind: decode?.kind ?? tt2.kind,
        ...(m.bitfield ? { bitfield: m.bitfield } : {}),
        ...(isComposite(tt2.kind) ? { struct: tt2.name } : {}),
      });
    }
  };
  await walk(full, 0);
  return { name: full.name ?? name, size: full.size, members: out };
}
