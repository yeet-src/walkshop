/* A walk event as a row: the fixed prefix, then each field's bytes
 * read back by the decode spec the compiler inferred from BTF.
 * Pure: no `yeet:*` imports. */

import { EDATA, HOOK, MAX_ITERS, NREGS, REG, ROOT_NAMES } from "./ops.js";

const AF_INET6 = 10;

/* A fixed C byte array, whichever shape it arrived in (an array from a
 * ring-buffer event, an object keyed by index from a data section, a
 * Latin-1 string), as a Uint8Array of at most `len` bytes. */
export function bytesOf(data, len) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return len == null ? data : data.subarray(0, len);
  if (typeof data === "string") {
    const n = len == null ? data.length : Math.min(len, data.length);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = data.charCodeAt(i) & 0xff;
    return out;
  }
  const values = Array.isArray(data) ? data : Object.values(data);
  const n = len == null ? values.length : Math.min(len, values.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Number(values[i]) & 0xff;
  return out;
}

export function commOf(bytes) {
  const b = bytesOf(bytes);
  let out = "";
  for (const c of b) {
    if (!c) break;
    out += String.fromCharCode(c);
  }
  return out;
}

export function addrOf(family, bytes) {
  const b = bytesOf(bytes, 16);
  if (family === AF_INET6) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push((((b[i * 2] ?? 0) << 8) | (b[i * 2 + 1] ?? 0)).toString(16));
    return parts.join(":");
  }
  return `${b[0] ?? 0}.${b[1] ?? 0}.${b[2] ?? 0}.${b[3] ?? 0}`;
}

const printable = (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "·");

const le = (b, len, signed = false) => {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
  if (signed && len && v & (1n << BigInt(len * 8 - 1))) v -= 1n << BigInt(len * 8);
  return v;
};
const beInt = (b, len) => {
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
};
const num = (v) => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

/** One captured entry (`bytes` of `len`) under `spec` → a JSON-able value. */
export function decodeEntry(bytes, len, spec) {
  const b = bytesOf(bytes, len);
  const n = b.length;
  switch (spec.kind) {
    case "str": {
      let s = "";
      for (const c of b) {
        if (!c) break;
        s += printable(c);
      }
      return s;
    }
    case "text":
    case "auto": {
      let s = "";
      for (let i = 0; i < n; i++) s += printable(b[i]);
      return s;
    }
    case "bytes": {
      let s = "";
      for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, "0");
      return s;
    }
    case "mac":
      return n >= 6 ? [...b.subarray(0, 6)].map((x) => x.toString(16).padStart(2, "0")).join(":") : null;
    case "json": {
      let s = "";
      for (let i = 0; i < n; i++) s += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : "\0";
      let i = s.indexOf(`"${spec.field}"`);
      if (i < 0) return null;
      i += spec.field.length + 2;
      while (i < s.length && (s[i] === " " || s[i] === ":")) i++;
      if (s[i] === '"') {
        let out = "";
        for (let j = i + 1; j < s.length && s[j] !== '"'; j++) out += s[j];
        return out;
      }
      let out = "";
      for (let j = i; j < s.length && !",}] \r\n\t\0".includes(s[j]); j++) out += s[j];
      if (out === "true") return true;
      if (out === "false") return false;
      if (out === "null") return null;
      return out === "" ? null : Number.isFinite(Number(out)) ? Number(out) : out;
    }
    case "ip4":
      return n >= 4 ? `${b[0]}.${b[1]}.${b[2]}.${b[3]}` : null;
    case "ip6":
      return n >= 16 ? addrOf(AF_INET6, b) : null;
    case "be":
      return num(beInt(b, n));
    case "bool":
      return Boolean(b[0]);
    case "ptr":
    case "hex":
      return "0x" + le(b, n).toString(16);
    case "enum": {
      const v = le(b, n, true);
      return spec.values?.[v.toString()] ?? num(v);
    }
    case "int":
    case "uint":
    default: {
      let v = le(b, n, spec.kind === "int" && !spec.bitfield);
      if (spec.bitfield) v = (v >> BigInt(spec.bitfield.bit_offset)) & ((1n << BigInt(spec.bitfield.bit_size)) - 1n);
      return num(v);
    }
  }
}

const at = (arr, i) => (Array.isArray(arr) ? arr[i] : (arr?.[i] ?? arr?.[String(i)]));

/**
 * One `walk_event` as a row. `values` is keyed by field name, `null`
 * for a field whose walk failed (a NULL pointer, a page not present, a
 * gate that did not hold). A payload window is cut to the bytes the
 * hook could read (`linear`). A field rooted at a base the frame does
 * not have (an Ethernet header on a raw-IP device) is null.
 */
export function decodeEvent(wrapped, fields) {
  const e = wrapped?.walk_event ?? wrapped;
  const family = Number(e.family ?? 0);
  const ok = Number(e.ok ?? 0);
  const edata = e.edata ?? [];
  const elen = e.elen ?? [];
  const eoff = e.eoff ?? [];
  const fcount = e.fcount ?? [];
  const linear = Number(e.linear ?? 0);
  const regs = [];
  for (let i = 0; i < NREGS; i++) regs.push(BigInt(at(e.regs, i) ?? 0));
  const hasL2 = regs[REG.L3] !== regs[REG.FRAME];

  const raw = {};
  const RAW_KINDS = new Set(["text", "auto", "bytes", "json", "str"]);
  const entry = (i, it, f) => {
    const idx = i * MAX_ITERS + it;
    let len = Number(at(elen, idx) ?? 0);
    if (f.decode.payload != null) {
      len = Math.max(0, Math.min(len, linear - f.decode.payload));
      if (len === 0) return null;
    }
    const off = Number(at(eoff, idx) ?? 0) & (EDATA - 1);
    const bytes = new Uint8Array(len);
    for (let k = 0; k < len; k++) bytes[k] = Number(at(edata, off + k) ?? 0) & 0xff;
    /* A window's bytes, as hex, beside the decoded value: the display
     * string loses what was not printable, and an inspector wants it. */
    if (RAW_KINDS.has(f.decode.kind) && it === 0) raw[f.name] = decodeEntry(bytes, len, { kind: "bytes" });
    return decodeEntry(bytes, len, f.decode);
  };

  const values = {};
  fields.forEach((f, i) => {
    if (!(ok & (1 << i)) || (f.decode.needs === "l2" && !hasL2)) {
      values[f.name] = null;
      return;
    }
    if ((f.maxIters ?? 1) > 1) {
      const n = Math.min(Number(at(fcount, i) ?? 0), MAX_ITERS);
      const list = [];
      for (let it = 0; it < n; it++) list.push(entry(i, it, f));
      values[f.name] = list;
      return;
    }
    values[f.name] = entry(i, 0, f);
  });

  const root = Number(e.root ?? 0);
  return {
    ts: BigInt(e.ts ?? 0),
    at: Date.now(),
    gen: Number(e.gen ?? 0),
    cpu: Number(e.cpu ?? 0),
    root: ROOT_NAMES[root] ?? String(root),
    hook: Number(e.hook ?? 0) === HOOK.TX ? "tx" : "rx",
    family,
    proto: Number(e.proto ?? 0),
    ifindex: Number(e.ifindex ?? 0),
    pid: Number(e.pid ?? 0),
    tid: Number(e.tid ?? 0),
    comm: commOf(e.comm),
    sport: Number(e.sport ?? 0),
    dport: Number(e.dport ?? 0),
    saddr: addrOf(family, e.saddr),
    daddr: addrOf(family, e.daddr),
    seq: Number(e.seq ?? 0) >>> 0,
    len: Number(e.len ?? 0),
    linear,
    regs: regs.map((r) => "0x" + r.toString(16)),
    values,
    raw,
  };
}

/** The prefix columns every row has, in display order, with how to read them. */
export const PREFIX = {
  ts: "nanoseconds since boot, from bpf_ktime_get_ns",
  at: "wall-clock milliseconds when the row reached the host",
  cpu: "the CPU the hook ran on",
  hook: "rx or tx: ingress/receive/SSL_read, egress/send/SSL_write",
  ifindex: "the interface (xdp, tcp, udp)",
  pid: "the process (tcp/udp on egress, https); 0 when there is none",
  tid: "the thread",
  comm: "the process name",
  family: "2 = IPv4, 10 = IPv6",
  proto: "6 = TCP, 17 = UDP",
  saddr: "source address",
  daddr: "destination address",
  sport: "source port",
  dport: "destination port",
  seq: "tcp: the segment's sequence number",
  len: "payload bytes (https: plaintext bytes)",
  linear: "of which the VM could read this many from payload",
  regs: "the register file, as hex, for the curious",
};
