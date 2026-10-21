/* The walk VM: a once-verified interpreter over whatever memory the
 * hook hands it.
 *
 * The program does not know what to read. It runs a small op program
 * per field, patched into the `programs` map from JS while it is
 * attached, that moves a cursor through memory (offset, dereference)
 * and copies a terminal value out. The op stream is the data, so a new
 * question — a different struct member, a pointer chased into another
 * object, a window of a packet's bytes — is a map update, never a
 * reload, and the verifier judged the program once.
 *
 * Every op runs as a `bpf_loop` step, so the verifier walks the
 * dispatch once per call site instead of once per slot per section
 * per field. And the VM's mutable state lives in a map element, not
 * on the stack: the verifier does not track map memory, so nothing the
 * ops do to the state can tell one loop iteration from the last, and
 * the callback loops converge at once. Only the pointers the verifier
 * must keep typed — the event being written, the state itself — ride
 * on the stack as the callback context.
 *
 * Included by each hook object after it defines, optionally:
 *   VM_USER        reads go through bpf_probe_read_user (uprobes)
 *   VM_STATE_TASK  state per task, not per CPU — for a hook that can
 *                  be preempted mid-run (a uprobe), where two tasks on
 *                  one CPU would otherwise share an element
 *   VM_SKB         the hook has a `struct __sk_buff *` and WOP_SKB reads
 *                  through bpf_skb_load_bytes, which follows the page
 *                  frags a probe read of the linear head cannot
 *
 * The hook's job is the prologue: parse what it has into the event's
 * fixed prefix, fill the registers, then call vm_run().
 */
#ifndef WALK_VM_H
#define WALK_VM_H

#include "event.h"

#ifdef VM_USER
#define VM_READ(dst, sz, src)     bpf_probe_read_user(dst, sz, (const void *) (src))
#define VM_READ_STR(dst, sz, src) bpf_probe_read_user_str(dst, sz, (const void *) (src))
#else
#define VM_READ(dst, sz, src)     bpf_probe_read_kernel(dst, sz, (const void *) (src))
#define VM_READ_STR(dst, sz, src) bpf_probe_read_kernel_str(dst, sz, (const void *) (src))
#endif

/* ---- control, patched from JS through the data section ------------------ */

volatile __u32 nfields[MAX_SLOTS]; /* fields armed per slot; 0 = quiet */
volatile __u32 gen[MAX_SLOTS];     /* generation stamped on each row */
volatile __u32 focus;              /* 1 = only flows with a port in focus_ports */
volatile __u32 focus_pid;          /* https: only this pid (0 = any) */
volatile __u32 data_only;          /* 1 = skip packets without payload */
volatile __u32 lo_ifindex;         /* tcx: loopback is seen on egress only */
volatile __u64 min_gap_ns;         /* at most one event per gap (0 = every one) */
volatile __u64 last_ns;
volatile __u64 seen, emitted, ring_full, parsed, matched;

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 1024);
} focus_ports SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 64);
} ignore_ports SEC(".maps");

/* ---- the programs and the state ----------------------------------------- */

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_SLOTS * MAX_FIELDS);
    __type(key, __u32);
    __type(value, struct walk_prog);
} programs SEC(".maps");

__attribute__((used)) static const struct walk_event __walk_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 23); /* 8 MiB: ~1000 events of 8 KiB */
} events SEC(".maps");

struct walk_state {
    __u64 regs[NREGS];
    __u32 slot;
    __u32 f;       /* the field being run */
    __u32 section; /* 0 = pre, terminals to nav_scratch; 1 = body, to the event */
    __u32 idx;     /* the entry a body terminal fills: ENTRY_IDX(f, it) */
    __u64 node;
    __u32 n;       /* ops in the section being run */
    __u64 cur;
    __u32 wrote;
    __u32 skip;
    __u32 live;
    __u32 used; /* bytes of the event's edata taken so far */
    __u32 _pad;
    __u64 scratch[NSCRATCH];
};

#ifdef VM_STATE_TASK
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u64);
    __type(value, struct walk_state);
} state SEC(".maps");

static __always_inline struct walk_state *vm_state_acquire(void)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct walk_state zero = {};
    bpf_map_update_elem(&state, &id, &zero, BPF_ANY);
    return bpf_map_lookup_elem(&state, &id);
}

static __always_inline void vm_state_release(void)
{
    __u64 id = bpf_get_current_pid_tgid();
    bpf_map_delete_elem(&state, &id);
}
#else
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct walk_state);
} state SEC(".maps");

static __always_inline struct walk_state *vm_state_acquire(void)
{
    __u32 zero = 0;
    return bpf_map_lookup_elem(&state, &zero);
}

static __always_inline void vm_state_release(void) {}
#endif

/* The callback context: the two pointers the verifier must keep typed.
 * bpf_loop requires it to be on the stack. */
struct walk_ctx {
    struct walk_event *e;
    struct walk_state *st;
#ifdef VM_SKB
    struct __sk_buff *skb;
    __u64 frame; /* what R_FRAME holds: the address skb offset 0 is at */
#endif
};

/* How many bytes a terminal may read from `cur`: when the cursor lies
 * inside the frame or buffer the hook described (R_FRAME to R_END), no
 * more than remain — a window longer than the packet reads the packet,
 * not nothing. Elsewhere (a struct member) the size stands. The result
 * is 0 only when nothing is left, which the caller treats as a failed
 * read; otherwise it is rebuilt into [1, ENTRY_CAP] by arithmetic the
 * verifier tracks, since the helpers refuse a size that may be zero. */
static __always_inline __u32 vm_clamp(struct walk_state *st, __u64 cur, __u32 sz)
{
    __u64 frame = st->regs[R_FRAME];
    __u64 end = st->regs[R_END];
    if (end && cur >= frame && cur < end) {
        __u64 avail = end - cur;
        if (avail < sz)
            sz = (__u32) avail;
    }
    return sz;
}

#define VM_BOUND(sz)                                  \
    do {                                              \
        barrier_var(sz);                              \
        sz = (((sz) - 1) & (ENTRY_CAP - 1)) + 1;      \
    } while (0)

/* Throwaway terminal buffer for a navigation-only pre. Global, not
 * stack: the frames of the nested loops share the 512-byte BPF stack.
 * CPUs may race on it; the contents are never read. */
static __u8 nav_scratch[ENTRY_CAP];

/* Where a terminal writes: the next free bytes of the event's edata
 * for a body section, the throwaway buffer for a pre. NULL when the
 * event has no room for another full entry — the verifier needs the
 * write bounded, and it is: `used` is masked, then held under
 * EDATA - ENTRY_CAP, and no terminal writes more than ENTRY_CAP. */
static __always_inline __u8 *terminal_out(struct walk_ctx *c, struct walk_state *st)
{
    if (!st->section)
        return nav_scratch;
    __u32 used = st->used & (EDATA - 1);
    if (used > EDATA - ENTRY_CAP)
        return NULL;
    return &c->e->edata[used];
}

static __always_inline struct walk_prog *prog_of(struct walk_state *st)
{
    __u32 key = ((st->slot * MAX_FIELDS) + st->f) & (MAX_SLOTS * MAX_FIELDS - 1);
    return bpf_map_lookup_elem(&programs, &key);
}

/* One op of a straight-line section, as a bpf_loop step. Returns 1 to
 * stop the section: past its end, or a read failed. */
static long vm_step(__u32 i, void *pctx)
{
    struct walk_ctx *c = pctx;
    struct walk_state *st = c->st;
    if (!st)
        return 1;
    if (i >= st->n || !st->live)
        return 1;
    if (st->skip > 0) {
        st->skip--;
        return 0;
    }
    struct walk_prog *p = prog_of(st);
    if (!p)
        return 1;
    struct walk_op *op = st->section ? &p->body[i & (MAX_STEP - 1)] : &p->pre[i & (MAX_STEP - 1)];
    __u32 code = op->code;
    __u32 arg = op->arg;
    __u64 cur = st->cur;
    __u8 *out = terminal_out(c, st);
    if (!out) {
        /* no room left in this event for another entry */
        st->live = 0;
        return 1;
    }

    switch (code) {
    case WOP_BASE:
        cur = st->regs[arg & (NREGS - 1)];
        break;
    case WOP_OFF:
        cur += arg;
        break;
    case WOP_BACK:
        cur -= arg;
        break;
    case WOP_DEREF: {
        __u64 next = 0;
        if (VM_READ(&next, sizeof(next), cur))
            st->live = 0;
        else
            cur = next;
        break;
    }
    case WOP_LOADN: {
        __u64 v = 0;
        __u32 sz = arg & 7;
        if (sz == 0)
            sz = 4;
        if (VM_READ(&v, sz, cur))
            st->live = 0;
        else
            cur = v;
        break;
    }
    case WOP_READ: {
        __u32 sz = arg & (ENTRY_CAP - 1);
        if (sz == 0)
            sz = 1;
        sz = vm_clamp(st, cur, sz);
        if (sz == 0) {
            st->live = 0;
            break;
        }
        VM_BOUND(sz);
        if (VM_READ(out, sz, cur))
            st->live = 0;
        else
            st->wrote = sz;
        break;
    }
    case WOP_STR: {
        long r = VM_READ_STR(out, ENTRY_CAP, cur);
        if (r < 0)
            st->live = 0;
        else
            st->wrote = (__u32) r;
        break;
    }
    case WOP_VAL: {
        __u32 sz = arg;
        if (sz == 0 || sz > 8)
            sz = 8;
        *(__u64 *) out = cur; /* all 8 written; the host reads `len` */
        st->wrote = sz;
        break;
    }
#ifdef VM_SKB
    case WOP_SKB: {
        /* The cursor is an address inside the frame, as every other op
         * sees it; the skb wants an offset. */
        __u32 sz = arg & (ENTRY_CAP - 1);
        if (sz == 0)
            sz = 1;
        __u64 off64 = cur - c->frame;
        if (off64 > 0xffff) {
            st->live = 0;
            break;
        }
        __u32 off = (__u32) off64;
        sz = vm_clamp(st, cur, sz);
        if (sz == 0) {
            st->live = 0;
            break;
        }
        VM_BOUND(sz);
        if (bpf_skb_load_bytes(c->skb, off, out, sz))
            st->live = 0;
        else
            st->wrote = sz;
        break;
    }
#endif
    case WOP_EQ:
        cur = (cur == (__u64) arg) ? 1 : 0;
        break;
    case WOP_LT:
        cur = (cur < (__u64) arg) ? 1 : 0;
        break;
    case WOP_GT:
        cur = (cur > (__u64) arg) ? 1 : 0;
        break;
    case WOP_AND:
        cur &= (__u64) arg;
        break;
    case WOP_SHR:
        cur >>= (arg & 63);
        break;
    case WOP_SKIPZ:
        if (cur == 0)
            st->skip = arg;
        break;
    case WOP_SKIPNZ:
        if (cur != 0)
            st->skip = arg;
        break;
    case WOP_STORE:
        st->scratch[arg & (NSCRATCH - 1)] = cur;
        break;
    case WOP_LOAD:
        cur = st->scratch[arg & (NSCRATCH - 1)];
        break;
    case WOP_ADD:
        cur += st->scratch[arg & (NSCRATCH - 1)];
        break;
    case WOP_SUB:
        cur -= st->scratch[arg & (NSCRATCH - 1)];
        break;
    default:
        st->live = 0;
        break;
    }

    st->cur = cur;
    return st->live ? 0 : 1;
}

/* Run a section: the field's pre (0) or body (1), `n` ops from cursor
 * `start`. Afterwards st->cur is where the cursor ended and st->wrote
 * how much a terminal emitted. */
static __always_inline void vm_section(struct walk_ctx *c, struct walk_state *st, __u32 section, __u32 n, __u64 start)
{
    st->section = section;
    st->n = n > MAX_STEP ? MAX_STEP : n;
    st->cur = start;
    st->wrote = 0;
    st->skip = 0;
    st->live = 1;
    for (int i = 0; i < NSCRATCH; i++)
        st->scratch[i] = 0;
    bpf_loop(MAX_STEP, vm_step, c, 0);
}

/* One chain node: run body from the node, emit an entry, advance via
 * next_off. Returns 1 to stop (NULL, a failed read, or a scalar's one
 * entry), 0 to continue. */
static long vm_node(__u32 it, void *pctx)
{
    struct walk_ctx *c = pctx;
    struct walk_state *st = c->st;
    if (!st)
        return 1;
    struct walk_prog *p = prog_of(st);
    if (!p)
        return 1;
    if (p->next_off && st->node == 0)
        return 1;
    __u32 key = st->f & (MAX_FIELDS - 1);
    __u32 idx = ENTRY_IDX(key, it);
    st->idx = idx;
    vm_section(c, st, 1, p->n_body, st->node);
    if (!st->live || st->wrote == 0)
        return 1;
    /* Masked again at each use: clang spills `key` as a 32-bit slot and
     * the verifier forgets the bound on the fill. */
    c->e->eoff[idx & (MAX_FIELDS * MAX_ITERS - 1)] = st->used & (EDATA - 1);
    c->e->elen[idx & (MAX_FIELDS * MAX_ITERS - 1)] = st->wrote;
    st->used += st->wrote & (ENTRY_CAP - 1);
    if (st->wrote >= ENTRY_CAP)
        st->used += ENTRY_CAP; /* a full STR read: the mask above dropped it */
    c->e->fcount[key & (MAX_FIELDS - 1)] = it + 1;
    c->e->ok |= (1u << (key & (MAX_FIELDS - 1)));
    if (p->next_off == 0)
        return 1;
    __u64 adv = 0;
    if (VM_READ(&adv, sizeof(adv), st->node + p->next_off))
        return 1;
    st->node = adv;
    return 0;
}

/* One field: reach the chain head (or, for a scalar, leave the cursor
 * wherever pre lands), then walk. */
static long vm_field(__u32 f, void *pctx)
{
    struct walk_ctx *c = pctx;
    struct walk_state *st = c->st;
    if (!st)
        return 1;
    st->f = f & (MAX_FIELDS - 1);
    struct walk_prog *p = prog_of(st);
    if (!p)
        return 0;

    vm_section(c, st, 0, p->n_pre, 0);
    /* A pre that failed (a NULL socket, a page not present) leaves the
     * cursor nowhere meaningful; the body would read from it and emit
     * a number that means nothing. The field is simply not there. */
    if (!st->live)
        return 0;
    st->node = st->cur;

    __u32 mi = p->max_iters;
    if (mi == 0)
        mi = 1;
    if (mi > MAX_ITERS)
        mi = MAX_ITERS;
    bpf_loop(mi, vm_node, c, 0);
    return 0;
}

/* ---- what a hook calls ---------------------------------------------------- */

/* Gate on the shared controls. Returns 1 when an event should be made. */
static __always_inline int vm_wanted(__u32 slot, __u32 sport, __u32 dport, __u32 plen)
{
    seen++;
    __u32 nf = nfields[slot & (MAX_SLOTS - 1)];
    if (nf == 0)
        return 0;
    /* The ports become map keys, so they need a stack slot. A 16-bit
     * value widened in a register makes clang spill a 64-bit slot
     * whose upper half it never defined, and the verifier refuses the
     * store of an uninitialised register. The barrier makes each a
     * value the compiler has to materialise in full. */
    __u32 sp = sport, dp = dport;
    barrier_var(sp);
    barrier_var(dp);
    if (bpf_map_lookup_elem(&ignore_ports, &sp) || bpf_map_lookup_elem(&ignore_ports, &dp))
        return 0;
    if (focus && !bpf_map_lookup_elem(&focus_ports, &sp) && !bpf_map_lookup_elem(&focus_ports, &dp))
        return 0;
    if (data_only && plen == 0)
        return 0;
    __u64 tnow = bpf_ktime_get_ns();
    if (min_gap_ns && tnow - last_ns < min_gap_ns)
        return 0;
    last_ns = tnow;
    return 1;
}

/* Reserve and prefix an event. NULL when the ring is full. */
static __always_inline struct walk_event *vm_begin(__u8 root, __u8 hook)
{
    struct walk_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) {
        ring_full++;
        return NULL;
    }
    e->ts = bpf_ktime_get_ns();
    e->cpu = bpf_get_smp_processor_id();
    e->ok = 0;
    e->root = root;
    e->hook = hook;
    e->family = 0;
    e->proto = 0;
    e->ifindex = 0;
    e->pid = 0;
    e->tid = 0;
    __builtin_memset(e->comm, 0, sizeof(e->comm));
    e->sport = 0;
    e->dport = 0;
    __builtin_memset(e->saddr, 0, 16);
    __builtin_memset(e->daddr, 0, 16);
    e->seq = 0;
    e->len = 0;
    e->linear = 0;
    for (int i = 0; i < NREGS; i++)
        e->regs[i] = 0;
    for (int f = 0; f < MAX_FIELDS; f++)
        e->fcount[f] = 0;
    e->used = 0;
    e->_pad2 = 0;
    return e;
}

/* Run the slot's fields over the registers in `e->regs`, then submit. */
#ifdef VM_SKB
static __always_inline void vm_run(struct walk_event *e, __u32 slot, struct __sk_buff *skb)
#else
static __always_inline void vm_run(struct walk_event *e, __u32 slot)
#endif
{
    struct walk_state *st = vm_state_acquire();
    if (!st) {
        bpf_ringbuf_discard(e, 0);
        return;
    }
    slot &= MAX_SLOTS - 1;
    e->gen = gen[slot];
    for (int i = 0; i < NREGS; i++)
        st->regs[i] = e->regs[i];
    st->slot = slot;
    st->used = 0;
    __u32 nf = nfields[slot];
    if (nf > MAX_FIELDS)
        nf = MAX_FIELDS;
    struct walk_ctx c = { .e = e, .st = st };
#ifdef VM_SKB
    c.skb = skb;
    c.frame = e->regs[R_FRAME];
#endif
    bpf_loop(nf, vm_field, &c, 0);
    e->used = st->used;
    vm_state_release();
    emitted++;
    bpf_ringbuf_submit(e, 0);
}

#endif
