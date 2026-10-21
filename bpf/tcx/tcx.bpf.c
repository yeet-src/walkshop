/* The tcp and udp roots: the walk VM on TCX, ingress and egress, every
 * interface.
 *
 * The hook sees every packet the stack sends or receives on a device,
 * both directions, loopback included, with the socket at hand on the
 * way out (`skb->sk` is the sender; on the way in no socket has been
 * looked up yet, so R_SK is 0 and a socket walk answers null). The
 * kernel's own `struct sk_buff` is reached through bpf_cast_to_kern_ctx,
 * so the VM walks the real skb, not the `__sk_buff` view.
 *
 * Two slots: slot 0 runs the tcp program on TCP packets, slot 1 the
 * udp program on UDP packets, so a query over both roots runs both at
 * once on one attachment.
 */

#define BPF_NO_KFUNC_PROTOTYPES
#define VM_SKB

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#include "pkt.h"
#include "vm.h"

char LICENSE[] SEC("license") = "GPL";

/* The kernel's skb behind the ctx. Declared here without the
 * __bpf_fastcall vmlinux.h gives it: with that attribute clang keeps
 * values live in r1-r5 across the call and the verifier rejects the
 * surrounding helper calls ("R1 !read_ok"). */
extern void *bpf_cast_to_kern_ctx(void *obj) __ksym;

#define TCX_NEXT (-1)
#define SLOT_TCP 0
#define SLOT_UDP 1

static __always_inline int find_ip(struct __sk_buff *skb, __u32 *nhoff, __u8 *version)
{
    __u16 eth_type = 0;
    __u8 v0 = 0, v14 = 0;
    if (bpf_skb_load_bytes(skb, 0, &v0, 1))
        return 0;
    if (!bpf_skb_load_bytes(skb, 12, &eth_type, 2) && !bpf_skb_load_bytes(skb, 14, &v14, 1)) {
        eth_type = bpf_ntohs(eth_type);
        if ((eth_type == ETH_P_IP && (v14 >> 4) == 4) || (eth_type == ETH_P_IPV6 && (v14 >> 4) == 6)) {
            *nhoff = 14;
            *version = v14 >> 4;
            return 1;
        }
    }
    if ((v0 >> 4) == 4 || (v0 >> 4) == 6) {
        *nhoff = 0;
        *version = v0 >> 4;
        return 1;
    }
    return 0;
}

static __always_inline int parse(struct __sk_buff *skb, struct pkt *p)
{
    __u32 nhoff = 0;
    __u8 version = 0;
    if (!find_ip(skb, &nhoff, &version))
        return 0;

    __builtin_memset(p->saddr, 0, 16);
    __builtin_memset(p->daddr, 0, 16);
    __u32 end = 0;

    if (version == 4) {
        struct pkt_ip4 ip;
        if (bpf_skb_load_bytes(skb, nhoff, &ip, sizeof(ip)))
            return 0;
        __u32 ihl = (__u32) (ip.vihl & 0x0f) * 4;
        if (ihl < 20)
            return 0;
        p->family = AF_INET;
        p->proto = ip.protocol;
        __builtin_memcpy(p->saddr, &ip.saddr, 4);
        __builtin_memcpy(p->daddr, &ip.daddr, 4);
        __u32 tot = bpf_ntohs(ip.tot_len);
        end = tot ? nhoff + tot : skb->len; /* tot_len is 0 on a BIG TCP skb */
        p->l4 = nhoff + ihl;
    } else {
        struct pkt_ip6 ip6;
        if (bpf_skb_load_bytes(skb, nhoff, &ip6, sizeof(ip6)))
            return 0;
        p->family = AF_INET6;
        p->proto = ip6.nexthdr; /* extension headers: not followed */
        __builtin_memcpy(p->saddr, ip6.saddr, 16);
        __builtin_memcpy(p->daddr, ip6.daddr, 16);
        __u32 plen = bpf_ntohs(ip6.payload_len);
        end = plen ? nhoff + 40 + plen : skb->len;
        p->l4 = nhoff + 40;
    }
    if (end > skb->len)
        end = skb->len;
    p->l3 = nhoff;
    p->end = end;
    p->seq = 0;

    if (p->proto == IPPROTO_TCP) {
        struct pkt_tcp th;
        if (bpf_skb_load_bytes(skb, p->l4, &th, sizeof(th)))
            return 0;
        __u32 doff = (__u32) (th.doff_res >> 4) * 4;
        if (doff < 20)
            return 0;
        p->sport = bpf_ntohs(th.source);
        p->dport = bpf_ntohs(th.dest);
        p->seq = bpf_ntohl(th.seq);
        p->payload = p->l4 + doff;
        return 1;
    }
    if (p->proto == IPPROTO_UDP) {
        struct pkt_udp uh;
        if (bpf_skb_load_bytes(skb, p->l4, &uh, sizeof(uh)))
            return 0;
        p->sport = bpf_ntohs(uh.source);
        p->dport = bpf_ntohs(uh.dest);
        p->payload = p->l4 + 8;
        return 1;
    }
    return 0;
}

static __always_inline int handle(struct __sk_buff *skb, __u8 hook)
{
    struct pkt p = {};
    if (!parse(skb, &p))
        return TCX_NEXT;
    parsed++;
    __u32 slot = p.proto == IPPROTO_TCP ? SLOT_TCP : SLOT_UDP;
    __u32 plen = p.end > p.payload ? p.end - p.payload : 0;
    if (!vm_wanted(slot, p.sport, p.dport, plen))
        return TCX_NEXT;
    matched++;

    struct walk_event *e = vm_begin(slot == SLOT_TCP ? ROOT_TCP : ROOT_UDP, hook);
    if (!e)
        return TCX_NEXT;
    e->family = p.family;
    e->proto = p.proto;
    e->ifindex = skb->ifindex;
    e->sport = p.sport;
    e->dport = p.dport;
    __builtin_memcpy(e->saddr, p.saddr, 16);
    __builtin_memcpy(e->daddr, p.daddr, 16);
    e->seq = p.seq;
    e->len = plen;

    /* The kernel's skb, its linear head, and its socket. */
    struct sk_buff *k = bpf_cast_to_kern_ctx(skb);
    __u64 frame = (__u64) BPF_CORE_READ(k, data);
    e->linear = plen; /* WOP_SKB reads across the frags */

    /* `skb->sk` is a struct sock only for a full socket. In TIME_WAIT
     * it is an inet_timewait_sock and in NEW_SYN_RECV a request_sock:
     * both start with sock_common and nothing else lines up, so a
     * tcp_sock walk (srtt, retrans, ca) would read garbage. Those walk
     * as null; the kernel's sk_fullsock() draws the same line. */
    struct sock *sk = BPF_CORE_READ(k, sk);
    if (sk) {
        __u8 st = BPF_CORE_READ(sk, __sk_common.skc_state);
        if ((1u << st) & ((1u << BPF_TCP_TIME_WAIT) | (1u << BPF_TCP_NEW_SYN_RECV)))
            sk = NULL;
    }
    e->regs[R_SK] = (__u64) sk;
    e->regs[R_SKB] = (__u64) k;
    e->regs[R_FRAME] = frame;
    e->regs[R_L3] = frame + p.l3;
    e->regs[R_L4] = frame + p.l4;
    e->regs[R_PAYLOAD] = frame + p.payload;
    e->regs[R_END] = frame + skb->len;
    e->regs[R_CTX] = (__u64) skb;

    /* Egress runs in the sender's context; ingress is a softirq, where
     * "current" is whoever was interrupted and means nothing. The ids
     * come off the task, not bpf_get_current_pid_tgid(): that helper
     * is only open to TC programs from 6.9, and 6.6 rejects the load. */
    if (hook == HOOK_TX) {
        struct task_struct *t = bpf_get_current_task_btf();
        e->pid = (__u32) BPF_CORE_READ(t, tgid);
        e->tid = (__u32) BPF_CORE_READ(t, pid);
        BPF_CORE_READ_STR_INTO(&e->comm, t, comm);
    }

    vm_run(e, slot, skb);
    return TCX_NEXT;
}

SEC("tcx/ingress")
int walk_ingress(struct __sk_buff *skb)
{
    if (skb->ifindex == lo_ifindex)
        return TCX_NEXT; /* already seen on the way out */
    return handle(skb, HOOK_RX);
}

SEC("tcx/egress")
int walk_egress(struct __sk_buff *skb)
{
    return handle(skb, HOOK_TX);
}
