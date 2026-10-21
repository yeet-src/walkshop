/* The https root: the walk VM in userspace, at the TLS boundary.
 *
 * uprobes on SSL_write (plaintext in `buf` at entry) and SSL_read (the
 * buffer is filled by return; entry stashes it, the return probe runs
 * the VM over it). The VM is the same one the kernel hooks run; it is
 * compiled here with VM_USER, so every read goes through
 * bpf_probe_read_user and a walk crosses the process's own memory —
 * the plaintext, and whatever the SSL object points at.
 *
 * A uprobe runs in the calling task's context and can be preempted,
 * so the state is per task (VM_STATE_TASK), not per CPU.
 *
 * The SSL * is stable for the connection's life and is the row's
 * connection id (R_CTX).
 */

#define BPF_NO_KFUNC_PROTOTYPES
#define VM_USER
#define VM_STATE_TASK

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#include "vm.h"

char LICENSE[] SEC("license") = "GPL";

struct read_args {
    __u64 ssl;
    __u64 buf;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);
    __type(value, struct read_args);
} active_reads SEC(".maps");

static __always_inline void run(__u64 ssl, __u64 buf, __u32 len, __u8 hook)
{
    __u64 id = bpf_get_current_pid_tgid();
    __u32 pid = (__u32) (id >> 32);
    if (focus_pid && pid != focus_pid)
        return;
    if (!vm_wanted(0, 0, 0, len))
        return;
    matched++;

    struct walk_event *e = vm_begin(ROOT_HTTPS, hook);
    if (!e)
        return;
    e->pid = pid;
    e->tid = (__u32) id;
    bpf_get_current_comm(e->comm, sizeof(e->comm));
    e->len = len;
    e->linear = len;
    e->regs[R_FRAME] = buf;
    e->regs[R_PAYLOAD] = buf;
    e->regs[R_END] = buf + len;
    e->regs[R_CTX] = ssl;
    vm_run(e, 0);
}

/* int SSL_write(SSL *ssl, const void *buf, int num) */
SEC("uprobe")
int BPF_KPROBE(ssl_write, void *ssl, const void *buf, int num)
{
    if (num > 0)
        run((__u64) ssl, (__u64) buf, (__u32) num, HOOK_TX);
    return 0;
}

/* int SSL_read(SSL *ssl, void *buf, int num) */
SEC("uprobe")
int BPF_KPROBE(ssl_read_enter, void *ssl, void *buf, int num)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .ssl = (__u64) ssl, .buf = (__u64) buf };
    bpf_map_update_elem(&active_reads, &id, &a, BPF_ANY);
    return 0;
}

SEC("uretprobe")
int BPF_KRETPROBE(ssl_read_exit, int ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args *a = bpf_map_lookup_elem(&active_reads, &id);
    if (!a)
        return 0;
    __u64 ssl = a->ssl, buf = a->buf;
    bpf_map_delete_elem(&active_reads, &id);
    if (ret > 0)
        run(ssl, buf, (__u32) ret, HOOK_RX);
    return 0;
}
