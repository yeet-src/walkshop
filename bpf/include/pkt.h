/* Finding the headers in a frame, for the packet roots (xdp, tcx).
 *
 * The parse is the only thing the hook does with its own knowledge of
 * packet layout, and it is deliberately small: where the IP header
 * starts (after an Ethernet header whose type agrees with the version
 * nibble that follows it, else at 0 — tunnel devices hand over raw
 * IP), which L4 protocol, where that header starts, and where it
 * ends. Everything past that — a flag, an option, a byte of body — is
 * the VM's to read, with offsets the host took from this kernel's BTF
 * for struct iphdr, tcphdr and udphdr.
 *
 * Two readers, one parse: xdp reads with bounded direct access, tcx
 * with bpf_skb_load_bytes, so each hook supplies a `ld(off, dst, sz)`
 * macro and includes the parse body through PKT_PARSE.
 */
#ifndef WALK_PKT_H
#define WALK_PKT_H

#define ETH_P_IP   0x0800
#define ETH_P_IPV6 0x86DD
#define AF_INET    2
#define AF_INET6   10

struct pkt {
    __u8  family;
    __u8  proto;    /* IPPROTO_TCP or IPPROTO_UDP */
    __u16 sport, dport;
    __u8  saddr[16], daddr[16];
    __u32 seq;
    __u32 l3, l4, payload, end; /* byte offsets from the frame start */
};

/* The fixed-layout headers, so a parse does not depend on vmlinux.h
 * spelling them with bitfields the compiler lays out differently. */
struct pkt_ip4 {
    __u8  vihl;
    __u8  tos;
    __u16 tot_len;
    __u16 id;
    __u16 frag_off;
    __u8  ttl;
    __u8  protocol;
    __u16 check;
    __u32 saddr;
    __u32 daddr;
};

struct pkt_ip6 {
    __u32 vtcfl;
    __u16 payload_len;
    __u8  nexthdr;
    __u8  hop_limit;
    __u8  saddr[16];
    __u8  daddr[16];
};

struct pkt_tcp {
    __u16 source;
    __u16 dest;
    __u32 seq;
    __u32 ack_seq;
    __u8  doff_res; /* data offset in the high nibble */
    __u8  flags;
    __u16 window;
    __u16 check;
    __u16 urg_ptr;
};

struct pkt_udp {
    __u16 source;
    __u16 dest;
    __u16 len;
    __u16 check;
};

#endif
