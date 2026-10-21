/* The query page: the workbench island, and nothing else. Every run
 * lives in the isolate (session.js) and goes until stopped; the
 * workbench shows them as tabs, polls the active one, and draws its
 * rows. This page, rendered in the isolate, only hands over the
 * examples. */
import Workbench from "@/lib/Workbench.jsx";

const EXAMPLES = {
  tcp: `{ tcp(data: true) {
    hook comm daddr dport len
    cwnd srtt dev
    inflight: sndNxt @minus(field: "sndUna")
    tcphdr { window syn ack }
    req: payload()
} }`,
  udp: `{ udp(ports: [53], data: true) {
    hook saddr daddr dport len
    ttl ulen
    q: payload(kind: bytes)
} }`,
  xdp: `{ xdp(iface: "wlp45s0", every: 50) {
    saddr daddr sport dport proto len
    ip { ttl }
    tcphdr { window }
} }`,
  https: `{ https {
    hook comm pid len
    line: payload()
} }`,
  transform: `{ tcp(ports: [80, 443]) { hook comm daddr dport len cwnd } }   # no data: true — the transform drops the empty ones
| context {
  let n = 0;
  const bytes = {};
}
| transform {
  if ($.len === 0) return null;          // drop bare ACKs
  bytes[$.daddr] = (bytes[$.daddr] ?? 0) + $.len;
  $.n = ++n;
  $.totalTo = bytes[$.daddr];
  $.kb = Math.round($.totalTo / 1024);
}`,
  struct: `{ struct(name: "tcp_sock") { name size members { name offset size type kind } } }`,
};

export default function Query() {
  return <Workbench examples={EXAMPLES} />;
}
