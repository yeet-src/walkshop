# walkshop

A once-verified BPF interpreter, queried in GraphQL. One VM, three
objects, four roots: `xdp`, `tcp`, `udp`, `https`.

The BPF program does not know what to read. A query names struct
members; the host resolves them through the running kernel's BTF into
the ops the VM runs — offsets, pointer chases, reads, arithmetic,
gates — patches them into a map, and the kernel starts answering.
Nothing is recompiled, and the verifier judged the program once.

Built on [yeetkit](vendor/yeetkit) (vendored): the app runs inside a
yeet isolate next to the kernel data it shows; the HTTP routes run in
Node; the page is Solid rendered over a socket.

```sh
npm install
npm run dev                       # make bpf, then http://localhost:3600
curl -s localhost:3600/api        # how to ask: roots, bases, directives, examples
curl -s localhost:3600/api/query -d '{ "query": "{ tcp(ports: [80], limit: 5) { hook comm daddr dport cwnd srtt req: payload(len: 48, kind: text) } }" }'
```

Needs `node`, `yeet` and a running `yeetd`, a kernel with BTF, TCX and
`bpf_cast_to_kern_ctx` (6.6+), and `libssl.so.3` for the `https` root.

## The layers, bottom up

| layer | where | what |
|---|---|---|
| **VM** | `bpf/include/vm.h`, `event.h` | the interpreter: 21 ops, 8 registers, 4 scratch, `bpf_loop` dispatch, state in a map element, one event shape (entries packed into 8 KiB per event, one entry up to 4 KiB) |
| **hooks** | `bpf/xdp/`, `bpf/tcx/`, `bpf/https/` | a prologue per hook: parse what it has, fill the registers, call `vm_run()` |
| **ops** | `app/lib/vm/` | `ops.js` mirrors the C; `resolve.js` asks BTF; `emit.js` turns terms into ops; `decode.js` reads rows back; `select.js` is the one-line front-end |
| **roots** | `app/lib/roots.js` | the four roots as data: object, slot, bases (register + struct), aliases, arguments |
| **query** | `app/lib/gql/` | `lex`, `parse`, `plan` (selection → terms, columns, filters, layout), `pipeline` (the `| context | transform` tail), `shape` (rows → nesting), `format`, `tokens` (for the editor), `schema` (the docs) |
| **probes** | `app/lib/probes/` | `attach.js` loads an object, patches programs, drains the ring, and lets several captures share a slot by merging their fields into one program and fanning rows back out; `registry.js` shares attachments across queries |
| **API** | `app/lib/query.js`, `app/api/` | `execute()` and `explain()`; `GET /` (the docs for anything that does not accept HTML, the app for a browser), `GET /api`, `GET /api/schema`, `POST /api/query`; `POST /api/chat` (a message to the chat's agent, the reply when done or streamed), `GET` / `DELETE /api/chat` |
| **chat** | `app/lib/chat/`, `app/lib/Chat.jsx` | an agent (`yeet:ai`, Opus by default) that answers in Markdown and places live instruments: `:::<object>{live=1000}` blocks whose JavaScript body runs in the isolate with the object as a global (`lineChart`, `sparkLine`, `stat`, `bars`, `table`, `log`, `canvas`, `gauge`, `heatmap`, `histogram`, `sankey`, `echarts` (any ECharts option, for the series types the others do not cover), and `ui`, a kit of functional builders — `ui.row/col/grid/tile/meter/gauge/spark/lines/bars/table/list/kv/code/hex/heat/hist/sankey/echarts` and `ui.h(tag, attrs, …kids)` — that compose a tree the page materialises; the object is also reachable as `ctx`) plus `query()`, `state` and `attrs`; the snapshot is pushed over the lane and drawn in the browser. The agent's one tool is the query language, so it looks before it draws; its system prompt is the `/api` page plus the block vocabulary |
| **UI** | `app/page.jsx`, `app/query/page.jsx`, `app/lib/Workbench.jsx` | what is attached; the workbench. The workbench is one browser island: tabs, one per run; an editor (a textarea over a mirror coloured by `gql/tokens.js`, the tolerant form of the compiler's lexer); the active run's rows, newest first, in a virtualised table coloured by each column's decode kind, window columns under their row (text as text, bytes as a coloured xxd dump), an inspector for the row you click. A run starts with one quick call (island → `actions.js` in Node → `session.js` in the isolate) and goes until stopped. The app runs in direct mode: the isolate pushes each row on its console lane, framed like the view with an op of its own, and the workbench reads them on a second WebSocket it dials itself — Node is out of the data path; a once-a-second poll carries status and backfills. Runs live in the isolate, so they are shared: a tab started in one browser is a tab in every browser |

Everything under `app/lib/vm/` and `app/lib/gql/` is pure and tested
with `npm test` against a hand-written BTF stub (`test/btf-stub.js`);
`app/lib/probes/` and `app/lib/query.js` are `"use yeet"` and run in
the isolate.

## The VM

A field is three sections — `pre[]` ops that reach a chain head,
`next_off` (0 for a scalar), `body[]` ops run per node — which gives
bounded iteration with no backward jump. Every op is one `bpf_loop`
step: the verifier walks the dispatch once per call site, not once per
slot per section per field. The VM's mutable state lives in a map
element (per CPU for the packet hooks, per task for the preemptible
uprobes), so nothing the ops do can tell one iteration from the last
and the loops converge at once; only the two pointers the verifier
must keep typed — the event being written, the state — ride on the
stack as the callback context.

| op | does |
|---|---|
| `base r` | cur = regs[r] |
| `off n` / `back n` | cur ± n |
| `deref` | cur = *(u64 *) cur |
| `loadn n` | cur = *(uN *) cur |
| `read n` / `str` / `val n` | terminals: n bytes at cur / a NUL-terminated string at cur / cur itself |
| `skb n` | terminal: n bytes of the packet at offset (cur − frame), through `bpf_skb_load_bytes` — tcx only, so a payload window spans the page frags |
| `eq i` / `lt i` / `gt i` | cur = (cur ? i) |
| `skipz n` / `skipnz n` | skip the next n ops on cur zero / non-zero |
| `store s` / `load s` / `add s` / `sub s` | the scratch registers |
| `and i` / `shr n` | mask, shift |

Registers: `sk`, `skb`, `frame`, `l3`, `l4`, `payload`, `end`, `ctx`.
A root fills what it has; a walk from an empty register fails its
first read and the column is null, which is the honest answer (no
socket on ingress, no headers in a TLS buffer).

Reads go through `bpf_probe_read_kernel`, or `bpf_probe_read_user` in
the `https` object (`VM_USER`). Three things the verifier taught this
VM, all in `vm.h`: the state in a map, the port keys materialised
through a barrier (a 16-bit value widened in a register makes clang
spill a slot whose upper half it never defined), and `struct pkt p =
{}` in the hooks (an unset field on the parse's failure path becomes
an `implicit-def` store the verifier rejects). And one thing the
packets taught it: a window read is clamped to what the hook has
(R_FRAME to R_END), since `bpf_skb_load_bytes` refuses a read past the
skb and a probe read past a buffer may fault — a 400-byte window on a
75-byte request reads 75 bytes, not nothing.

## The roots

| root | object | hook | registers |
|---|---|---|---|
| `xdp` | `bin/xdp.bpf.o` | `SEC("xdp")` on named interfaces, receive only | frame, l3, l4, payload, end, ctx |
| `tcp` | `bin/tcx.bpf.o` slot 0 | `tcx/ingress` + `tcx/egress`, every interface | + the kernel's skb (`bpf_cast_to_kern_ctx`) and, on egress, `skb->sk` |
| `udp` | `bin/tcx.bpf.o` slot 1 | same attachment | same |
| `https` | `bin/https.bpf.o` | uprobes on `SSL_read` / `SSL_write` | frame = payload = the plaintext, end, ctx = the `SSL *` |

Each root's **bases** are what a selection walks from — a register and
the struct it points at: `sock`, `tcp`, `inet`, `icsk`, `skb`, `eth`,
`ip`, `ip6`, `tcphdr`, `udphdr`, `udp`, `ssl`. A leaf under a base is a
member by its C name, nested as the structs nest; BTF decides whether
a hop is an embedded struct (an offset) or a pointer (a deref). The
member's type decides how it reads back: an int's signedness, a
`__be16`/`__be32` typedef (a port, an address), a `char[]`, a `char[6]`
(a MAC), an enum's names, a bitfield's position, `struct in6_addr`.
`(kind:, size:)` overrides. `self` is a base's address, `at(offset:,
len:, kind:)` raw bytes from it, `payload(offset:, len:, kind:)` on a
root the bytes past the L4 header or the TLS plaintext (`kind` defaults
to `auto`, text or a hex dump decided per row by what the bytes look
like; `len` to 1024 for text, 256 for bytes; up to 4095).

The event's fixed prefix — `ts cpu hook ifindex pid tid comm family
proto saddr daddr sport dport seq len linear` — is read by the hook
through CO-RE or from the headers it parsed, so it is free; the VM's
eight fields per root are for what you select.

## The query

```graphql
{ tcp(ports: [80, 443], limit: 20, ms: 3000) {
    hook comm daddr dport len
    cwnd srtt dev
    inflight: sndNxt @minus(field: "sndUna")
    https: tcphdr { dest @when(eq: 443) }
    tcphdr { window syn ack }
    req: payload(len: 64, kind: text)
} }
```

A pipeline tail runs JavaScript over the rows in the isolate, with
the kernel still capturing only what was selected:

```graphql
{ tcp(ports: [80, 443]) { hook comm daddr len } }
| context   { let n = 0; const bytes = {}; }
| transform { if ($.len === 0) return null; bytes[$.daddr] = (bytes[$.daddr] ?? 0) + $.len; $.n = ++n; $.total = bytes[$.daddr]; }
```

`$` is the row as the selection shaped it, `root` the root it came
from. Mutate `$`, `return` a new object to reshape the row (its keys
become the columns), or `return null` to drop it. `context` runs once
per run and its declarations are in scope for every transform; several
transforms chain. The tail is split off by JavaScript lexical rules
(`app/lib/gql/pipeline.js`) before the GraphQL is lexed.

Directives compile into the ops: `@when(eq|ne|lt|gt:, field:)` gates
the emit (a big-endian field byte-swaps the immediate for you, so the
query says 443); `@minus`/`@plus(field:)` fold a sibling through the
scratch registers; `@and(mask:)`/`@shr(bits:)` mask and shift. On a
prefix column `@when` filters host-side. Meta roots: `struct(name:)`
lists a struct's members from BTF; `roots` is the table above as data;
`__schema` the SDL. `POST /api/query` with `"explain": true` returns
the ops without running.

```sh
npm test                                            # the pure modules, against the BTF stub
npm run test:wire                                   # the query page in jsdom with the real bundles, against `npm run dev` (add --port for another server)
yeet run scripts/selftest.js -- --root tcp --ports 80 --data --select "cwnd, srtt, dev, req: payload(0, 64, text)"
yeet run scripts/selftest.js -- --root udp --ports 53 --select "ttl, ulen, q: payload(0, 32, bytes)"
yeet run scripts/selftest.js -- --root xdp --iface wlp45s0 --select "ttl, ip.protocol, window"
yeet run scripts/selftest.js -- --root https --select "line: payload(0, 80, text)"
yeet run scripts/query.js -- --q '{ udp(ports: [53], limit: 5) { saddr daddr ulen } }'
yeet run scripts/query.js -- --explain --q '{ tcp { inflight: sndNxt @minus(field: "sndUna") } }'
```

The event is one fixed struct (the daemon drops a shorter ring record),
so its entries are packed: a terminal writes at the event's `used`
offset and bumps it, and an event is a head plus 8 KiB of entries, one
entry up to 4 KiB — not sixteen slots of 4 KiB, almost all zero.

Several queries may run on one root at once — two tabs, a page and an
API call: their fields are merged into one program (identical fields
are shared, distinct ones take their own entry) and each gets its own
rows back. The merged set must fit the VM's eight fields; a query that
would not fit is refused with what the others hold.

Verified here (kernel 7.2.6, x86_64): all three objects load and
verify; `tcp` reads `snd_cwnd`, `srtt_us`, the route's device name
through two pointers, the TCP header's window and a request line
through the skb on egress, and the response on ingress; `udp` sees a
DNS query and its reply on the wifi device; `xdp` sees ttl and ports
off the wire; `https` sees curl's HTTP/2 plaintext through libssl.

## The chat

```
:::lineChart{live=1500 title="srtt by peer" unit="ms"}
const d = await query("{ tcp(data: true, limit: 40, ms: 700) { hook daddr srtt } }");
for (const r of d.tcp ?? []) if (r.hook === "tx" && r.srtt) lineChart.push(r.daddr, r.srtt / 1000);
:::
```

The agent can work on its own. A `:::watch{every=3000 title="…"}`
block is a predicate the host keeps evaluating; when its body returns
a value (or calls `watch.fire(payload)`) the agent wakes: a new turn in
the same conversation with that value as the message. One player: a
single turn runs at a time, wakes queue behind it, one per watch with
a ten-second cooldown, and a person's message goes first — a noisy
condition cannot flood the chat. `watch.stop()` ends a watch,
`forever=true` keeps it past the fifteen-minute expiry, and an empty
`:::done` block stops every block and watch when the job is finished.

The dashboard is a pinboard: a block with `pin=true` (and `span=2` or
`3` of three columns) becomes a tile on a responsive grid that overlays
the chat, shared by every viewer and fed by the same snapshots; `[pin]`
under any block does the same by hand. The agent works the board as
the conversation goes — `board.list()`, `pin`, `unpin`, `span`, `move`,
`stop`, `clear` are globals in its snippets and blocks, and each turn
tells it what the board holds — so "make the chart full width and drop
the table" is one request. With the overlay up the prompt stays, and
the conversation flows in a see-through panel in the corner.

A block's body is compiled once (an `AsyncFunction` whose parameters are
its scope) and run on the host against one object that lives for the
block — a live chart keeps its history, and a run's pushes to one
series average into one point; with `live=<ms>` it reruns on that
interval, at most twelve live blocks, each expiring after fifteen
minutes. `query()` is the same executor the API uses. The object
collects; the browser draws (`lib/chat/Widgets.jsx`): the line chart, bars, gauge,
heatmap, histogram and sankey are [Apache ECharts](https://echarts.apache.org),
with the page's theme registered on load — the prebuilt module is served
from `public/vendor/` and imported at runtime, so the island bundle stays
small and the dev bundler never chews through it; each widget is one
chart instance fed by a merged `setOption` per snapshot, so lines and
bars animate from their last frame, and the line chart slides a window
of the last `window` seconds; a
`canvas` is a recorded 2D context replayed on a real one. Replies stream over the
lane and the conversation is shared by every viewer. Needs `yeet login`
on the host — the daemon answers for the account it was logged in as.

## Not yet

Chains
(`next_off`, `max_iters` are in the VM, not in the query); an
`SSL_read_ex`/`SSL_write_ex` object for CPython; Go and rustls; the
`eth` base is null on raw-IP devices (tailscale) by design; the
socket is null on ingress by design. The walkshop itself — the
step-by-step site — comes next, on top of this.
