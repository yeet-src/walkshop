/* The shapes every walkshop object shares: the op, the field program,
 * the event a run emits, and the register file the hooks fill.
 *
 * One VM (vm.h), three objects (bpf/xdp, bpf/tcx, bpf/https), four
 * query roots (xdp, tcp, udp, https). The roots differ only in what
 * their prologue puts in the registers and in which memory the reads
 * go through; the ops, the maps and the event are the same, so the JS
 * side has one compiler, one decoder and one loader.
 *
 * Mirrored field for field in app/lib/vm/ops.js. Keep the two in step.
 */
#ifndef WALK_EVENT_H
#define WALK_EVENT_H

#define MAX_SLOTS  2   /* programs an object runs at once (tcx: tcp and udp) */
#define MAX_FIELDS 8   /* columns per program */
#define MAX_STEP   8   /* ops per pre[] / body[] section */
#define MAX_ITERS  2    /* nodes visited per chain field */
#define ENTRY_CAP  4096 /* bytes one entry may hold; a power of two */
#define EDATA      8192 /* bytes of entries per event, packed; a power of two, at least 2 × ENTRY_CAP */
#define NREGS      8
#define NSCRATCH   4   /* writable scratch registers; a power of two */

/* The register file. A root fills what it has and leaves the rest 0;
 * a walk from an empty register fails its first read and the column
 * is null, which is the honest answer (no socket on ingress, no
 * headers in a TLS buffer). */
#define R_SK      0 /* struct sock *            tcx egress; 0 on ingress, xdp, https */
#define R_SKB     1 /* struct sk_buff *         tcx (the kernel skb, not the ctx) */
#define R_FRAME   2 /* first byte the hook sees: L2 or L3 (tcx, xdp); the buffer (https) */
#define R_L3      3 /* the IP header */
#define R_L4      4 /* the TCP or UDP header */
#define R_PAYLOAD 5 /* first byte after L4 (tcx, xdp); the plaintext (https) */
#define R_END     6 /* one past the last readable byte of the frame or buffer */
#define R_CTX     7 /* the hook's own context: xdp_md *, __sk_buff *, the SSL * */

enum walk_root { ROOT_XDP = 0, ROOT_TCP = 1, ROOT_UDP = 2, ROOT_HTTPS = 3 };
enum walk_hook { HOOK_RX = 0, HOOK_TX = 1 }; /* xdp: rx; tcx: ingress/egress; https: read/write */

/* WOP_READ copies memory at `cur` out; WOP_VAL copies `cur` itself, for
 * a computed value. WOP_LOADN pulls an N-byte scalar at `cur` INTO
 * `cur`; EQ/LT/GT compare `cur` with the immediate and leave 0 or 1;
 * SKIPZ/SKIPNZ skip the next `arg` ops on cur zero / non-zero — a
 * forward skip, never a backward jump. STORE/LOAD/ADD/SUB go through
 * the scratch registers for arithmetic between two reads; AND and SHR
 * mask and shift `cur`, for a bitfield or a flag. */
enum {
    WOP_END = 0,
    WOP_BASE,   /* cur = regs[arg] */
    WOP_OFF,    /* cur += arg */
    WOP_DEREF,  /* cur = *(u64 *) cur */
    WOP_READ,   /* out[0..arg) = memory at cur; terminal */
    WOP_STR,    /* out = NUL-terminated string at cur; terminal */
    WOP_VAL,    /* out = cur, arg bytes of it; terminal */
    WOP_LOADN,  /* cur = *(uN *) cur, N = arg & 7 (0 → 4) */
    WOP_EQ,     /* cur = (cur == arg) */
    WOP_SKIPZ,  /* if (!cur) skip arg ops */
    WOP_SKIPNZ, /* if (cur) skip arg ops */
    WOP_BACK,   /* cur -= arg */
    WOP_STORE,  /* scratch[arg] = cur */
    WOP_LOAD,   /* cur = scratch[arg] */
    WOP_ADD,    /* cur += scratch[arg] */
    WOP_SUB,    /* cur -= scratch[arg] */
    WOP_LT,     /* cur = (cur < arg), unsigned */
    WOP_GT,     /* cur = (cur > arg), unsigned */
    WOP_AND,    /* cur &= arg */
    WOP_SHR,    /* cur >>= arg */
    WOP_SKB,    /* out[0..arg) = skb bytes at offset (cur - R_FRAME), across frags; tcx only; terminal */
    WOP_COUNT
};

struct walk_op {
    __u32 code;
    __u32 arg;
};

/* A field is three sections, which gives the VM bounded iteration
 * without a backward jump the verifier would reject:
 *   pre[]     straight-line ops that leave `cur` at a chain head
 *   next_off  byte offset of the "next" pointer within a node (0 = scalar)
 *   body[]    straight-line ops run per node, from that node's address,
 *             whose terminal read emits one list entry */
struct walk_prog {
    __u32 n_pre;
    struct walk_op pre[MAX_STEP];
    __u32 next_off;
    __u32 max_iters;
    __u32 n_body;
    struct walk_op body[MAX_STEP];
};

#define ENTRY_IDX(f, it) (((f) * MAX_ITERS + (it)) & (MAX_FIELDS * MAX_ITERS - 1))

struct walk_event {
    __u64 ts;
    __u32 cpu;
    __u32 gen;  /* the program generation this row ran under */
    __u32 ok;   /* bit f set when field f produced at least one entry */
    __u8  root; /* enum walk_root */
    __u8  hook; /* enum walk_hook */
    __u8  family;
    __u8  proto;
    __u32 ifindex;
    __u32 pid;
    __u32 tid;
    __u8  comm[16];
    __u16 sport; /* host order */
    __u16 dport;
    __u8  saddr[16]; /* v4 in the first 4 bytes */
    __u8  daddr[16];
    __u32 seq;    /* tcp: the segment's sequence number */
    __u32 len;    /* bytes of payload (https: of plaintext) */
    __u32 linear; /* of which this many the VM could read from R_PAYLOAD */
    __u64 regs[NREGS];
    __u32 fcount[MAX_FIELDS]; /* entries produced by field f */
    __u32 eoff[MAX_FIELDS * MAX_ITERS]; /* where entry (f, it) starts in edata */
    __u32 elen[MAX_FIELDS * MAX_ITERS];
    __u32 used;  /* bytes of edata written */
    __u32 _pad2;
    /* Entries are packed, not slotted: a terminal writes at `used` and
     * bumps it, so an event is the size of what was read plus a fixed
     * head — not sixteen slots of ENTRY_CAP, almost all zero. The ring
     * record is still one fixed struct (the daemon drops a shorter one),
     * so this is as small as the event gets: a head and EDATA bytes. */
    __u8  edata[EDATA];
};

#endif
