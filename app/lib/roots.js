/* The four roots, as data.
 *
 * A root is a hook and a register file. Its `bases` are the names a
 * query walks from — each a register and the struct that register
 * points at, resolved through BTF at query time — and its `object` is
 * the BPF object that serves it. The packet roots share the frame
 * landmarks (eth, ip, ip6, tcp, udp) because every hook that sees a
 * frame fills the same registers; what differs is what else is there:
 * the kernel's skb and, on egress, the socket (tcp, udp), or nothing
 * but the frame (xdp), or a process's own memory (https).
 *
 * Pure data; no `yeet:*` imports. */

import { REG } from "./vm/ops.js";

const FRAME = {
  eth: { reg: REG.FRAME, struct: "ethhdr", needs: "l2", doc: "the Ethernet header, when the device has one" },
  ip: { reg: REG.L3, struct: "iphdr", doc: "the IPv4 header" },
  ip6: { reg: REG.L3, struct: "ipv6hdr", doc: "the IPv6 header" },
};

const SOCK = {
  sock: { reg: REG.SK, struct: "sock", doc: "struct sock — on egress, for a full socket; null on ingress (no socket looked up yet) and on a TIME_WAIT or NEW_SYN_RECV socket, which is not a struct sock" },
  inet: { reg: REG.SK, struct: "inet_sock", doc: "the same socket as inet_sock" },
  skb: { reg: REG.SKB, struct: "sk_buff", doc: "the kernel's own sk_buff" },
};

/* Friendly names, resolved against BTF like any path — never a baked offset. */
const TCP_ALIASES = {
  cwnd: "tcp.snd_cwnd",
  ssthresh: "tcp.snd_ssthresh",
  sndNxt: "tcp.snd_nxt",
  sndUna: "tcp.snd_una",
  rcvNxt: "tcp.rcv_nxt",
  sndWnd: "tcp.snd_wnd",
  rcvWnd: "tcp.rcv_wnd",
  srtt: "tcp.srtt_us",
  mdev: "tcp.mdev_us",
  mss: "tcp.mss_cache",
  retrans: "tcp.total_retrans",
  lost: "tcp.lost_out",
  bytesAcked: "tcp.bytes_acked",
  bytesReceived: "tcp.bytes_received",
  bytesSent: "tcp.bytes_sent",
  segsIn: "tcp.segs_in",
  segsOut: "tcp.segs_out",
  rto: "icsk.icsk_rto",
  ca: "icsk.icsk_ca_state",
  rcvbuf: "sock.sk_rcvbuf",
  sndbuf: "sock.sk_sndbuf",
  dev: "sock.sk_dst_cache.dev.name",
  mtu: "sock.sk_dst_cache.dev.mtu",
  protoName: "sock.__sk_common.skc_prot.name",
  inode: "sock.sk_socket.file.f_inode.i_ino",
  ttl: "ip.ttl",
  window: "tcphdr.window",
  syn: "tcphdr.syn",
  fin: "tcphdr.fin",
  rst: "tcphdr.rst",
  ack: "tcphdr.ack",
  psh: "tcphdr.psh",
};

const UDP_ALIASES = {
  rcvbuf: "sock.sk_rcvbuf",
  sndbuf: "sock.sk_sndbuf",
  dev: "sock.sk_dst_cache.dev.name",
  mtu: "sock.sk_dst_cache.dev.mtu",
  inode: "sock.sk_socket.file.f_inode.i_ino",
  ttl: "ip.ttl",
  ulen: "udphdr.len",
};

export const ROOTS = {
  xdp: {
    name: "xdp",
    id: 0,
    object: "xdp",
    slot: 0,
    hook: "XDP on one interface, receive only, before the kernel has built an skb",
    bases: {
      ...FRAME,
      tcphdr: { reg: REG.L4, struct: "tcphdr", doc: "the TCP header, when proto is 6" },
      udphdr: { reg: REG.L4, struct: "udphdr", doc: "the UDP header, when proto is 17" },
    },
    aliases: { ttl: "ip.ttl", window: "tcphdr.window", syn: "tcphdr.syn", ulen: "udphdr.len" },
    args: { iface: "String! — the interface to attach to (name or index)", proto: "tcp | udp — narrow in the kernel", ports: "[Int] — only flows with one of these ports", data: "Boolean — only frames with payload", every: "Int — at most one row per this many ms", limit: "Int — rows (default 50)", ms: "Int — how long to hold the hook (default 2000)" },
    payload: REG.PAYLOAD,
  },
  tcp: {
    name: "tcp",
    id: 1,
    object: "tcx",
    slot: 0,
    hook: "TCX ingress and egress on every interface, loopback included",
    bases: {
      ...SOCK,
      tcp: { reg: REG.SK, struct: "tcp_sock", doc: "the same socket as tcp_sock — the full TCP state" },
      icsk: { reg: REG.SK, struct: "inet_connection_sock", doc: "the same socket as inet_connection_sock" },
      ...FRAME,
      tcphdr: { reg: REG.L4, struct: "tcphdr", doc: "the TCP header" },
    },
    aliases: TCP_ALIASES,
    args: { ports: "[Int]", data: "Boolean", every: "Int", limit: "Int", ms: "Int", iface: "[String] — interfaces to watch (default all)" },
    payload: REG.PAYLOAD,
    skb: true, /* payload windows read through the skb, frags included */
  },
  udp: {
    name: "udp",
    id: 2,
    object: "tcx",
    slot: 1,
    hook: "TCX ingress and egress on every interface, loopback included",
    bases: {
      ...SOCK,
      udp: { reg: REG.SK, struct: "udp_sock", doc: "the same socket as udp_sock" },
      ...FRAME,
      udphdr: { reg: REG.L4, struct: "udphdr", doc: "the UDP header" },
    },
    aliases: UDP_ALIASES,
    args: { ports: "[Int]", data: "Boolean", every: "Int", limit: "Int", ms: "Int", iface: "[String]" },
    payload: REG.PAYLOAD,
    skb: true,
  },
  https: {
    name: "https",
    id: 3,
    object: "https",
    slot: 0,
    hook: "uprobes on SSL_read and SSL_write in libssl — the plaintext, in the process's own memory",
    bases: {
      ssl: { reg: REG.CTX, struct: null, doc: "the SSL object; no BTF for it, read it with at(offset, len, kind)" },
    },
    aliases: {},
    args: { pid: "Int — only this process", binary: "String — the libssl to probe (default: the host's)", data: "Boolean", every: "Int", limit: "Int", ms: "Int" },
    payload: REG.PAYLOAD,
  },
};

/** Expand an alias to `{ base, members }`, or split a dotted path. */
export function splitPath(root, path) {
  const alias = root.aliases[path];
  if (alias) return splitPath(root, alias);
  const [head, ...rest] = path.split(".");
  const headAlias = root.aliases[head];
  if (headAlias) return splitPath(root, `${headAlias}.${rest.join(".")}`);
  if (!root.bases[head]) throw new Error(`unknown base \`${head}\`; the ${root.name} root walks from ${Object.keys(root.bases).join(", ")}${Object.keys(root.aliases).length ? `, or an alias: ${Object.keys(root.aliases).join(", ")}` : ""}`);
  return { base: head, members: rest };
}

export const ROOT_NAMES_LIST = Object.keys(ROOTS);
