/* The xdp root: the walk VM at the earliest hook there is.
 *
 * XDP runs in the driver, on receive, before the kernel has built an
 * skb — there is no socket, no process, no `struct sk_buff`, only the
 * frame. So this root's registers are the frame's own landmarks (L3,
 * L4, payload, end) and a walk reads packet bytes with offsets the
 * host took from BTF for struct iphdr, tcphdr and udphdr. Both TCP and
 * UDP frames run slot 0; the query's `proto` argument narrows.
 *
 * The program returns XDP_PASS on every path: it looks, never drops.
 */

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>

#include "pkt.h"
#include "vm.h"

char LICENSE[] SEC("license") = "GPL";

volatile __u32 proto_filter; /* 0 = any, else IPPROTO_TCP or IPPROTO_UDP */

static __always_inline int parse(void *data, void *data_end, struct pkt *p)
{
    __u32 nhoff = 0;
    __u8 version = 0;

    /* Ethernet whose type agrees with the version nibble after it, else raw IP. */
    if (data + 15 <= data_end) {
        __u16 eth_type = bpf_ntohs(*(__u16 *) (data + 12));
        __u8 v14 = *(__u8 *) (data + 14) >> 4;
        if ((eth_type == ETH_P_IP && v14 == 4) || (eth_type == ETH_P_IPV6 && v14 == 6)) {
            nhoff = 14;
            version = v14;
        }
    }
    if (!version) {
        if (data + 1 > data_end)
            return 0;
        __u8 v0 = *(__u8 *) data >> 4;
        if (v0 != 4 && v0 != 6)
            return 0;
        version = v0;
    }

    __builtin_memset(p->saddr, 0, 16);
    __builtin_memset(p->daddr, 0, 16);
    __u32 len = (__u32) (data_end - data);
    __u32 end = 0;

    if (version == 4) {
        struct pkt_ip4 *ip = data + nhoff;
        if ((void *) (ip + 1) > data_end)
            return 0;
        __u32 ihl = (__u32) (ip->vihl & 0x0f) * 4;
        if (ihl < 20)
            return 0;
        p->family = AF_INET;
        p->proto = ip->protocol;
        __builtin_memcpy(p->saddr, &ip->saddr, 4);
        __builtin_memcpy(p->daddr, &ip->daddr, 4);
        __u32 tot = bpf_ntohs(ip->tot_len);
        end = tot ? nhoff + tot : len;
        p->l4 = nhoff + ihl;
    } else {
        struct pkt_ip6 *ip6 = data + nhoff;
        if ((void *) (ip6 + 1) > data_end)
            return 0;
        p->family = AF_INET6;
        p->proto = ip6->nexthdr;
        __builtin_memcpy(p->saddr, ip6->saddr, 16);
        __builtin_memcpy(p->daddr, ip6->daddr, 16);
        __u32 plen = bpf_ntohs(ip6->payload_len);
        end = plen ? nhoff + 40 + plen : len;
        p->l4 = nhoff + 40;
    }
    if (end > len)
        end = len;
    p->l3 = nhoff;
    p->end = end;
    p->seq = 0;

    /* l4 is at most nhoff + 60; bound it for the pointer arithmetic below. */
    __u32 l4 = p->l4 & 0xff;
    if (p->proto == IPPROTO_TCP) {
        struct pkt_tcp *th = data + l4;
        if ((void *) (th + 1) > data_end)
            return 0;
        __u32 doff = (__u32) (th->doff_res >> 4) * 4;
        if (doff < 20)
            return 0;
        p->sport = bpf_ntohs(th->source);
        p->dport = bpf_ntohs(th->dest);
        p->seq = bpf_ntohl(th->seq);
        p->payload = l4 + doff;
        return 1;
    }
    if (p->proto == IPPROTO_UDP) {
        struct pkt_udp *uh = data + l4;
        if ((void *) (uh + 1) > data_end)
            return 0;
        p->sport = bpf_ntohs(uh->source);
        p->dport = bpf_ntohs(uh->dest);
        p->payload = l4 + 8;
        return 1;
    }
    return 0;
}

SEC("xdp")
int walk_xdp(struct xdp_md *ctx)
{
    void *data = (void *) (long) ctx->data;
    void *data_end = (void *) (long) ctx->data_end;
    struct pkt p = {};
    if (!parse(data, data_end, &p))
        return XDP_PASS;
    parsed++;
    if (proto_filter && p.proto != proto_filter)
        return XDP_PASS;
    __u32 plen = p.end > p.payload ? p.end - p.payload : 0;
    if (!vm_wanted(0, p.sport, p.dport, plen))
        return XDP_PASS;
    matched++;

    struct walk_event *e = vm_begin(ROOT_XDP, HOOK_RX);
    if (!e)
        return XDP_PASS;
    e->family = p.family;
    e->proto = p.proto;
    e->ifindex = ctx->ingress_ifindex;
    e->sport = p.sport;
    e->dport = p.dport;
    __builtin_memcpy(e->saddr, p.saddr, 16);
    __builtin_memcpy(e->daddr, p.daddr, 16);
    e->seq = p.seq;
    e->len = plen;
    e->linear = plen; /* the whole frame is linear here */

    __u64 frame = (__u64) (long) data;
    e->regs[R_FRAME] = frame;
    e->regs[R_L3] = frame + p.l3;
    e->regs[R_L4] = frame + p.l4;
    e->regs[R_PAYLOAD] = frame + p.payload;
    e->regs[R_END] = (__u64) (long) data_end;
    e->regs[R_CTX] = (__u64) (long) ctx;

    vm_run(e, 0);
    return XDP_PASS;
}
