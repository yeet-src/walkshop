/* The one page an agent reads before asking: what this is, how to ask,
 * the schema, the query language, the directives, the pipeline, the
 * meta roots, the limits, and a working loop. Rendered from the roots
 * table, so it cannot drift from the code. The struct members
 * themselves are not listed — they come from the running kernel's BTF,
 * through `{ struct(name: "tcp_sock") }`. Pure. */

import { PREFIX } from "../vm/decode.js";
import { MAX_FIELDS, MAX_READ, MAX_STEP } from "../vm/ops.js";
import { KINDS } from "../vm/resolve.js";
import { ROOTS } from "../roots.js";

const kinds = [...KINDS].filter((k) => k !== "enum").join(" ");

const argTable = (root) =>
  Object.entries(root.args)
    .map(([n, d]) => `| \`${n}\` | ${d.replace(/\|/g, "\\|")} |`)
    .join("\n");

const baseTable = (root) =>
  Object.entries(root.bases)
    .map(([n, b]) => `| \`${n}\` | ${b.struct ? `\`struct ${b.struct}\`` : "no BTF"} | ${b.doc ?? ""} |`)
    .join("\n");

const aliasList = (root) =>
  Object.entries(root.aliases)
    .map(([n, p]) => `\`${n}\` → \`${p}\``)
    .join(", ");

function rootDoc(root) {
  return `### ${root.name}

${root.hook}.

| argument | meaning |
|---|---|
${argTable(root)}

Bases — what a selection walks from, each a register and the struct it points at:

| base | struct | what it is |
|---|---|---|
${baseTable(root)}
${Object.keys(root.aliases).length ? `\nAliases, usable as leaves directly under the root: ${aliasList(root)}.\n` : ""}`;
}

export const SDL = `# walkshop — a once-verified BPF interpreter, queried in GraphQL.
#
# One VM, three objects, four roots. A query selects what to read; the
# host resolves every member name through this kernel's BTF into the
# ops the VM runs — offsets, pointer chases, reads — patches them into
# a map, and the kernel starts answering. Nothing is recompiled.
#
# Each root streams one row per event (a packet, a TLS read or write)
# for \`ms\` milliseconds or until \`limit\` rows. Prefix columns are
# free; everything else costs one of the VM's ${MAX_FIELDS} fields.

type Query {
  xdp(iface: [String]!, proto: Proto, ports: [Int], data: Boolean, every: Int, limit: Int, ms: Int): [XdpRow]
  tcp(iface: [String], ports: [Int], data: Boolean, every: Int, limit: Int, ms: Int): [TcpRow]
  udp(iface: [String], ports: [Int], data: Boolean, every: Int, limit: Int, ms: Int): [UdpRow]
  https(pid: Int, binary: String, data: Boolean, every: Int, limit: Int, ms: Int): [HttpsRow]
  struct(name: String!): Struct     # a struct's members from BTF: name, offset, size, type, kind
  roots: [Root]                     # the roots, bases, aliases and arguments, as data
  __schema: String                  # this text
}

# Every row has these, from the event's fixed prefix — free:
${Object.entries(PREFIX)
  .map(([n, d]) => `#   ${n.padEnd(8)} ${d}`)
  .join("\n")}
#
# Below the prefix, a row is what you selected: a base and its members,
# nested as the structs nest; an alias; a payload window.

enum Proto { tcp udp }
enum Kind { ${kinds} }   # plus "json:<field>" as a string
`;

export const DOCS = `# walkshop

A once-verified BPF interpreter, queried in GraphQL. One VM, three BPF
objects, four roots: \`xdp\`, \`tcp\`, \`udp\`, \`https\`.

The BPF program does not know what to read. A query names struct
members; the host resolves them through the running kernel's BTF into
the ops the VM runs — offsets, pointer chases, reads, arithmetic,
gates — patches them into a map, and the kernel starts answering.
Nothing is recompiled, and the verifier judged the program once. This
page is the whole contract: read it, then ask.

## How to ask

| route | what |
|---|---|
| \`GET /\` | this page, unless the request accepts HTML — then the app |
| \`GET /api\` | this page |
| \`GET /api/schema\` | the SDL alone |
| \`POST /api/query\` | run a query; the body is \`{ "query": "…" }\` as JSON, or the query itself with \`Content-Type: application/graphql\` |
| \`POST /api/query\` with \`{ "query": "…", "explain": true }\` | compile without running: the ops per field |
| \`GET /api/query?query=…\` | the same, URL-encoded |
| \`POST /api/query?stream=1\` | the rows as they arrive, as a Markdown table per root, a line per row, until \`limit\` or \`ms\` is reached or you hang up |
| \`POST /api/query?stream=1\` with \`Accept: application/x-ndjson\` | the same, one JSON object per line: \`{ "root": "tcp", …row }\` |
| \`POST /api/query\` with \`Accept: text/markdown\` and \`?stream=0\` | one Markdown table per root once the run is done |

The one-shot reply is standard GraphQL: \`{ "data": { … } }\`, or \`{ "data": …, "errors": [{ "message", "line", "path" }] }\`.
A root with a compile error is reported and the other roots still run.
A query that yields no data at all is a 400.

Stream when the window is long: a one-shot call must finish inside
about 30 s, a streamed run has as long as you keep reading, and a query
with neither \`limit\` nor \`ms\` streams until you close the connection.
Streamed rows carry \`at\` (host clock, ms) and \`ts\` (kernel clock, ns).
In a Markdown stream a cell is one line (a newline in a payload shows
as ⏎), errors are \`> error:\` lines and a meta root is a fenced JSON
block at the end; in NDJSON they are \`{ "errors": [...] }\` and
\`{ "root", "meta" }\` lines.

\`\`\`sh
curl -sN 'localhost:3600/api/query?stream=1' -H 'content-type: application/graphql' -d '
{ tcp(data: true, ms: 20000) { hook daddr dport srtt } }'
\`\`\`

\`\`\`
### tcp

| hook | daddr | dport | srtt | at |
|---|---|---|---|---|
| tx | 104.20.23.154 | 443 | 14250 | 1761080412345 |
| rx | 127.0.0.1 | 8090 | 212 | 1761080412351 |
\`\`\`

\`\`\`sh
curl -s localhost:3600/api/query -H 'content-type: application/graphql' -d '
{ tcp(ports: [80], data: true, limit: 5, ms: 3000) {
    hook comm daddr dport len
    cwnd srtt
    req: payload(len: 120, kind: text)
} }'
\`\`\`

\`\`\`json
{ "data": { "tcp": [
  { "hook": "tx", "comm": "curl", "daddr": "93.184.215.14", "dport": 80, "len": 75,
    "cwnd": 10, "srtt": 38120, "req": "GET / HTTP/1.1··Host: example.com··…" },
  { "hook": "rx", "comm": "", "daddr": "192.168.0.8", "dport": 52384, "len": 931,
    "cwnd": null, "srtt": null, "req": "HTTP/1.1 200 OK··Date: …" }
] } }
\`\`\`

A query holds the kernel for \`ms\` (default 2000, at most 15000) or
until \`limit\` rows (default 50, at most 1000). Rows come oldest first.
Something must be on the wire: a root with no matching traffic answers
an empty list, not an error.

## The shape of a query

A root, its arguments, and a selection set. Inside the selection:

- **Prefix columns** — \`hook comm daddr dport len …\` — are read by the
  hook into every event and cost nothing. The full list is in the SDL.
- **A base** — \`tcp { snd_cwnd }\`, \`sock { sk_dst_cache { dev { name } } }\` —
  is a register and the struct it points at. A leaf under it is a
  member by its C name; nesting follows an embedded struct (an offset)
  or chases a pointer (a deref) — BTF decides which, and the member's
  type decides how the bytes read back: an int's signedness, a
  \`__be16\`/\`__be32\` typedef (a port, an address), a \`char[]\` (a string),
  a \`char[6]\` (a MAC), an enum's names, a bitfield's position,
  \`struct in6_addr\`. \`(kind: …, size: …)\` overrides.
- **An alias** — \`cwnd srtt dev ttl window syn …\` — is a named path, directly
  under the root; the table per root lists them.
- **\`payload(offset:, len:, kind:)\`** on a root is a window of the packet's
  bytes past the L4 header, or of the TLS plaintext. \`kind\` defaults to
  \`auto\` (text when the bytes are mostly printable, a hex dump otherwise,
  decided per row), \`len\` to 1024 for text and 256 for bytes, up to
  ${MAX_READ}. A window longer than the packet reads the packet.
- **\`at(offset:, len:, kind:)\`** under any base reads raw bytes from the
  base's address — the only way into a base without BTF, such as
  \`https.ssl\`. **\`self\`** under a base is its address.
- **Alias any leaf** with \`name: leaf\`; a selected name must be unique.

Each base, alias, \`payload\` or \`at\` leaf costs one of the VM's
${MAX_FIELDS} fields per root; a field runs up to ${2 * MAX_STEP} ops,
and a pointer crossed costs two. Kinds: ${kinds}, and \`"json:<field>"\`
(a JSON value scanned out of a window).

A socket walk (\`sock\`, \`tcp\`, \`inet\`, \`icsk\`, \`udp\`) answers on egress,
where the sender's socket is known; on ingress no socket has been
looked up yet and the column is null. It is also null on egress when
the socket is not a full one — a SYN-ACK or its retransmit is sent for
a request_sock (state 12, NEW_SYN_RECV), a final ACK by a timewait sock
(state 6) — since neither is a struct tcp_sock and a walk into one
would read garbage. That is the honest answer, not an error. The
\`eth\` base is null on raw-IP devices (a tunnel), for the same reason.
\`iface\` on \`tcp\`/\`udp\` keeps only rows seen on those interfaces (name
or index; the object itself stays on every interface, shared by every
run); an unknown name is an error that lists what the host has.

## Directives

They compile into the ops — the kernel does the work:

| directive | effect |
|---|---|
| \`@when(eq: N)\`, \`ne\`, \`lt\`, \`gt\` | emit the leaf only when the member compares so; a big-endian field byte-swaps for you, so \`tcphdr { dest @when(eq: 443) }\` says 443 |
| \`@when(field: "x", eq: N)\` | …when a sibling (or an alias, or \`base.member\`) compares so |
| \`@minus(field: "x")\`, \`@plus(field: "x")\` | this ∓ a sibling, in the kernel: \`inflight: sndNxt @minus(field: "sndUna")\` |
| \`@and(mask: N)\`, \`@shr(bits: N)\` | mask and shift a value |

On a prefix column, \`@when\` filters host-side: \`hook @when(eq: "tx")\`.

## The pipeline

After the selection, JavaScript over the rows, in the isolate, with the
kernel still capturing only what was selected:

\`\`\`graphql
{ tcp(ports: [80, 443]) { hook comm daddr len cwnd } }
| context   { let n = 0; const bytes = {}; }
| transform { if ($.len === 0) return null; bytes[$.daddr] = (bytes[$.daddr] ?? 0) + $.len; $.n = ++n; $.total = bytes[$.daddr]; }
\`\`\`

\`$\` is the row as the selection shaped it, \`root\` the root it came
from. Mutate \`$\`, \`return\` a new object to reshape the row (its keys
become the columns), or \`return null\` to drop it. \`context\` runs once
per run and its declarations are in scope for every transform; several
transforms chain in order.

## Discovering the kernel

The member names are the kernel's own, and the kernel decides them.
Three meta roots answer without touching a hook:

\`\`\`graphql
{ struct(name: "tcp_sock") { name size members { name offset size type kind } } }
{ roots { name object hook args { name doc } bases { name struct doc } aliases { name path } } }
{ __schema }
\`\`\`

\`struct\` lists a struct's members from the running kernel's BTF — name,
byte offset, size, C type, and the kind the bytes read back as — so a
member you have not seen is one query away. Pointers are listed with
their target type; select through one to chase it.

## What the kernel ran

\`explain: true\` returns the compiled program per field without running
it — the ops, the decode, how the ops split across the VM's two
sections:

\`\`\`json
{ "roots": [ { "root": "tcp", "fields": [
  { "name": "cwnd",     "decode": { "kind": "uint", "size": 4 }, "ops": "base sk; off 1492; read 4" },
  { "name": "dev",      "decode": { "kind": "str", "size": 16 },  "ops": "base sk; off 552; deref; deref; off 288; str" },
  { "name": "inflight", "decode": { "kind": "uint", "size": 4 }, "ops": "base sk; off 1720; loadn 4; store; base sk; off 1716; loadn 4; sub; val 4" },
  { "name": "req",      "decode": { "kind": "text", "size": 120, "payload": 0 }, "ops": "base payload; skb 120" }
] } ] }
\`\`\`

The offsets are this kernel's, resolved at that moment; on another
kernel the same query compiles to other numbers. That is the point.

## A loop for an agent

1. \`GET /api\` once. Everything you need to write a query is here.
2. If a member name is in doubt, \`{ struct(name: "…") { members { name kind } } }\`.
3. \`POST /api/query\` with \`"explain": true\` to check the query compiles,
   and to see what it costs.
4. \`POST /api/query\` with a short \`ms\` and a small \`limit\` first; widen
   once the columns look right, and stream (\`?stream=1\`, or
   \`Accept: text/markdown\`) once the window passes a few seconds. Narrow with \`ports\`, \`data: true\` (skip
   bare ACKs), \`every\` (at most one row per N ms) — the kernel filters
   before an event is written, so narrow is cheaper than wide.
5. Put judgement in the pipeline, not in a second query: drop, count,
   reshape rows as they stream.

Several queries may run on one root at once — yours, a page, another
agent: their fields are merged into one program and each gets its own
rows back. The merged set must fit the VM's ${MAX_FIELDS} fields per
root; a query that would not fit is refused with what the others hold.

## A conversation, for an agent

The page's chat is an agent of its own — it answers in prose and
places live instruments — and it has a door:

| route | what |
|---|---|
| \`POST /api/chat\` | send a message (\`{ "message": "…" }\` as JSON, or plain text); the call waits for the reply (up to \`?wait=<ms>\`, 110 s at most) and answers with its text, the blocks it placed, and what it looked at |
| \`POST /api/chat?stream=1\` | the same, the reply streamed as text as it is written, then one line of JSON with the blocks |
| \`GET /api/chat\` | the conversation so far |
| \`DELETE /api/chat\` | clear it and stop its instruments |

The conversation is one and shared: a message posted here appears on
every open chat page, and so does the reply. A block in the reply is
\`{ id, object, attrs, source }\` — the JavaScript the chat's agent wrote,
already running on the host and drawn on the page.

\`\`\`sh
curl -s localhost:3600/api/chat -d '{ "message": "who is this box talking to right now?" }'
\`\`\`

## Roots

${Object.values(ROOTS).map(rootDoc).join("\n")}

## Examples

\`\`\`graphql
{ tcp(data: true, limit: 20, ms: 3000) {
    hook comm daddr dport len
    cwnd srtt dev
    inflight: sndNxt @minus(field: "sndUna")
    tcphdr { window syn ack }
    req: payload(len: 200)
} }
\`\`\`

\`\`\`graphql
{ udp(ports: [53], data: true, limit: 10) {
    saddr daddr dport len ttl
    q: payload(offset: 12, len: 40, kind: text)
} }
\`\`\`

\`\`\`graphql
{ xdp(iface: "eth0", proto: tcp, every: 10, limit: 10) {
    saddr daddr sport dport
    ip { ttl protocol }
    tcphdr { window }
} }
\`\`\`

\`\`\`graphql
{ https(limit: 10, ms: 5000) {
    hook pid comm len
    line: payload(len: 400)
} }
\`\`\`

\`\`\`graphql
{ tcp(ports: [443]) { hook daddr len }
  struct(name: "tcphdr") { members { name offset size kind } } }
| transform { if ($.len < 100) return null; }
\`\`\`

## Limits

| limit | value |
|---|---|
| VM fields per root | ${MAX_FIELDS} (prefix columns are free) |
| ops per field | ${2 * MAX_STEP} (a pointer costs two) |
| bytes per read | ${MAX_READ} |
| \`ms\` | at most 15000 |
| \`limit\` | at most 1000 |
| one program per root at a time | queries on the same root share it (above) |

## The schema

\`\`\`graphql
${SDL}\`\`\`
`;
