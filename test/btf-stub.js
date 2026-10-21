/* A stand-in for `yeet:btf` over a few hand-written types, with the
 * same contract: type(name) / expand(id) / peel(id) / walk(struct,
 * path) — walk() descends anonymous members, crosses pointers as
 * deref hops, and reports bitfields as the daemon does. Offsets are
 * invented; the compiler must never assume any. */

const INT = (id, name, size, signed = false, char = false) => ({ id, kind: "int", name, size, encoding: { signed, char, bool: false } });

const T = {
  /* ints and typedefs */
  30: INT(30, "int", 4, true),
  31: INT(31, "short unsigned int", 2),
  33: INT(33, "unsigned char", 1),
  44: INT(44, "unsigned int", 4),
  45: INT(45, "long long unsigned int", 8),
  50: INT(50, "char", 1, true, true),
  40: { id: 40, kind: "typedef", name: "__be32", type: { id: 44 } },
  41: { id: 41, kind: "typedef", name: "__be16", type: { id: 42 } },
  42: { id: 42, kind: "typedef", name: "__u16", type: { id: 31 } },
  43: { id: 43, kind: "typedef", name: "u32", type: { id: 44 } },
  46: { id: 46, kind: "typedef", name: "__u8", type: { id: 33 } },
  49: { id: 49, kind: "typedef", name: "u64", type: { id: 45 } },
  51: { id: 51, kind: "typedef", name: "u8", type: { id: 33 } },
  52: { id: 52, kind: "typedef", name: "__sum16", type: { id: 42 } },
  32: { id: 32, kind: "volatile", type: { id: 33 } },

  /* sock and friends */
  1: { id: 1, kind: "struct", name: "sock", size: 776, members: [
    { name: "__sk_common", offset: 0, type: { id: 2, kind: "struct", name: "sock_common", size: 136 } },
    { name: "sk_rcvbuf", offset: 244, type: { id: 30, kind: "int", name: "int", size: 4 } },
    { name: "sk_dst_cache", offset: 552, type: { id: 20, kind: "ptr", size: 8 } },
    { name: "sk_v6_daddr", offset: 720, type: { id: 90, kind: "struct", name: "in6_addr", size: 16 } },
  ] },
  2: { id: 2, kind: "struct", name: "sock_common", size: 136, members: [
    { offset: 0, type: { id: 3, kind: "union", size: 8 } },
    { offset: 12, type: { id: 5, kind: "union", size: 4 } },
    { name: "skc_family", offset: 16, type: { id: 31, kind: "int", name: "short unsigned int", size: 2 } },
    { name: "skc_state", offset: 18, type: { id: 32, kind: "volatile" } },
  ] },
  3: { id: 3, kind: "union", size: 8, members: [{ offset: 0, type: { id: 4, kind: "struct", size: 8 } }] },
  4: { id: 4, kind: "struct", size: 8, members: [
    { name: "skc_daddr", offset: 0, type: { id: 40, kind: "typedef", name: "__be32" } },
    { name: "skc_rcv_saddr", offset: 4, type: { id: 40, kind: "typedef", name: "__be32" } },
  ] },
  5: { id: 5, kind: "union", size: 4, members: [{ offset: 0, type: { id: 6, kind: "struct", size: 4 } }] },
  6: { id: 6, kind: "struct", size: 4, members: [
    { name: "skc_dport", offset: 0, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "skc_num", offset: 2, type: { id: 42, kind: "typedef", name: "__u16" } },
  ] },
  10: { id: 10, kind: "struct", name: "tcp_sock", size: 2432, members: [
    { name: "snd_cwnd", offset: 1492, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "snd_nxt", offset: 1716, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "snd_una", offset: 1720, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "srtt_us", offset: 1784, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "bytes_acked", offset: 1840, type: { id: 49, kind: "typedef", name: "u64" } },
    { name: "repair", offset: 1511, bitfield: { bit_offset: 0, bit_size: 1 }, type: { id: 51, kind: "typedef", name: "u8" } },
    { name: "rx_opt", offset: 1600, type: { id: 11, kind: "struct", name: "tcp_options_received", size: 24 } },
  ] },
  11: { id: 11, kind: "struct", name: "tcp_options_received", size: 24, members: [
    { name: "ts_recent", offset: 4, type: { id: 43, kind: "typedef", name: "u32" } },
  ] },
  20: { id: 20, kind: "ptr", size: 8, target: { id: 21, kind: "struct", name: "dst_entry", size: 200 } },
  21: { id: 21, kind: "struct", name: "dst_entry", size: 200, members: [
    { name: "dev", offset: 0, type: { id: 22, kind: "ptr", size: 8 } },
  ] },
  22: { id: 22, kind: "ptr", size: 8, target: { id: 23, kind: "struct", name: "net_device", size: 2400 } },
  23: { id: 23, kind: "struct", name: "net_device", size: 2400, members: [
    { name: "name", offset: 288, type: { id: 24, kind: "array" } },
    { name: "mtu", offset: 400, type: { id: 44, kind: "int", name: "unsigned int", size: 4 } },
  ] },
  24: { id: 24, kind: "array", nelems: 16, elem: { id: 50, kind: "int", name: "char", size: 1 } },
  60: { id: 60, kind: "struct", name: "sk_buff", size: 232, members: [
    { name: "len", offset: 112, type: { id: 44, kind: "int", name: "unsigned int", size: 4 } },
  ] },
  90: { id: 90, kind: "struct", name: "in6_addr", size: 16, members: [] },

  /* the headers */
  100: { id: 100, kind: "struct", name: "iphdr", size: 20, members: [
    { name: "ihl", offset: 0, bitfield: { bit_offset: 0, bit_size: 4 }, type: { id: 46, kind: "typedef", name: "__u8" } },
    { name: "version", offset: 0, bitfield: { bit_offset: 4, bit_size: 4 }, type: { id: 46, kind: "typedef", name: "__u8" } },
    { name: "ttl", offset: 8, type: { id: 46, kind: "typedef", name: "__u8" } },
    { name: "protocol", offset: 9, type: { id: 46, kind: "typedef", name: "__u8" } },
    { name: "saddr", offset: 12, type: { id: 40, kind: "typedef", name: "__be32" } },
    { name: "daddr", offset: 16, type: { id: 40, kind: "typedef", name: "__be32" } },
  ] },
  101: { id: 101, kind: "struct", name: "tcphdr", size: 20, members: [
    { name: "source", offset: 0, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "dest", offset: 2, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "seq", offset: 4, type: { id: 40, kind: "typedef", name: "__be32" } },
    { name: "doff", offset: 12, bitfield: { bit_offset: 4, bit_size: 4 }, type: { id: 42, kind: "typedef", name: "__u16" } },
    { name: "syn", offset: 12, bitfield: { bit_offset: 9, bit_size: 1 }, type: { id: 42, kind: "typedef", name: "__u16" } },
    { name: "window", offset: 14, type: { id: 41, kind: "typedef", name: "__be16" } },
  ] },
  102: { id: 102, kind: "struct", name: "udphdr", size: 8, members: [
    { name: "source", offset: 0, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "dest", offset: 2, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "len", offset: 4, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "check", offset: 6, type: { id: 52, kind: "typedef", name: "__sum16" } },
  ] },
  103: { id: 103, kind: "struct", name: "ethhdr", size: 14, members: [
    { name: "h_dest", offset: 0, type: { id: 104, kind: "array" } },
    { name: "h_source", offset: 6, type: { id: 104, kind: "array" } },
    { name: "h_proto", offset: 12, type: { id: 41, kind: "typedef", name: "__be16" } },
  ] },
  104: { id: 104, kind: "array", nelems: 6, elem: { id: 33, kind: "int", name: "unsigned char", size: 1 } },
};

const byName = (name) => Object.values(T).find((t) => t.name === name && (t.kind === "struct" || t.kind === "union"));
const ref = (t) => ({ id: t.id, kind: t.kind, ...(t.name ? { name: t.name } : {}), ...(t.size != null ? { size: t.size } : {}), ...(t.target ? { target: t.target } : {}), ...(t.elem ? { elem: t.elem, nelems: t.nelems } : {}), ...(t.encoding ? { encoding: t.encoding } : {}) });

function peelId(id) {
  const typedefs = [];
  let t = T[id];
  while (t && (t.kind === "typedef" || t.kind === "volatile" || t.kind === "const")) {
    if (t.kind === "typedef") typedefs.push(t.name);
    t = T[t.type.id];
  }
  if (!t) throw new Error(`no type ${id}`);
  return { type: ref(t), typedefs };
}

function locate(t, name) {
  for (const m of t.members ?? []) {
    if (m.name === name) return m;
    if (!m.name && (m.type.kind === "struct" || m.type.kind === "union")) {
      const found = locate(T[m.type.id], name);
      if (found) return found;
    }
  }
  return null;
}

/* Offsets of anonymous members accumulate: locate() returns the member
 * with its own offset, so walk adds the anonymous container's. */
function locateAt(t, name, base = 0) {
  for (const m of t.members ?? []) {
    if (m.name === name) return { m, at: base + m.offset };
    if (!m.name && (m.type.kind === "struct" || m.type.kind === "union")) {
      const found = locateAt(T[m.type.id], name, base + m.offset);
      if (found) return found;
    }
  }
  return null;
}

export const btf = {
  async type(name, { kind } = {}) {
    const t = byName(name);
    if (!t || (kind && t.kind !== kind)) throw new Error(`no ${kind ?? "type"} named ${name}`);
    return ref(t);
  },
  async expand(id) {
    const t = T[id];
    if (!t) throw new Error(`no type ${id}`);
    return { ...ref(t), ...(t.members ? { members: t.members } : {}), ...(t.values ? { values: t.values } : {}) };
  },
  async peel(id) {
    return peelId(id);
  },
  async walk(struct, path) {
    let cur = byName(struct);
    if (!cur) throw new Error(`no struct named ${struct}`);
    const names = path.split(".");
    const hops = [];
    let at = 0;
    for (let i = 0; i < names.length; i++) {
      const found = locateAt(cur, names[i]);
      if (!found) throw new Error(`struct ${cur.name ?? "(anon)"} has no member ${names[i]}. Available members: ${(cur.members ?? []).map((m) => m.name).filter(Boolean).join(", ")}`);
      at += found.at;
      const { type: t } = peelId(found.m.type.id);
      const last = i === names.length - 1;
      if (last) {
        hops.push({ op: "load", at, width: t.kind === "ptr" ? 8 : (t.size ?? 8) });
        return { hops, type: t, ...(found.m.bitfield ? { bitfield: found.m.bitfield } : {}) };
      }
      if (t.kind === "ptr") {
        hops.push({ op: "deref", at });
        at = 0;
        cur = T[t.target.id];
      } else if (t.kind === "struct" || t.kind === "union") {
        cur = T[t.id];
      } else {
        throw new Error(`${names[i]} is a ${t.kind}; cannot descend`);
      }
    }
    throw new Error("empty path");
  },
};
