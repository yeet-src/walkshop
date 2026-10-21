"use client";

/* The first requests to make against this host, written for wherever
 * the page was opened from: the isolate knows only the path, so this
 * runs in the browser and reads the origin. Each line is one click to
 * copy. */
import { For } from "solid-js";

import CodeView from "./CodeView.jsx";

export default function Try() {
  const origin = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:3600";
  const examples = [
    {
      what: "stream tcp as a Markdown table until Ctrl-C",
      cmd: `curl -sN '${origin}/api/query?stream=1' -H 'content-type: application/graphql' -d '{ tcp(data: true) { hook comm daddr dport len srtt } }'`,
    },
    {
      what: "ten request lines on port 80, then stop",
      cmd: `curl -sN '${origin}/api/query?stream=1' -H 'content-type: application/graphql' -d '{ tcp(ports: [80], data: true, limit: 10) { comm daddr req: payload(len: 80, kind: text) } }'`,
    },
    {
      what: "a metric per endpoint: packets, bytes and smoothed RTT per peer:port, kept in a JavaScript transform (srtt_us is 8 × µs)",
      cmd: `curl -sN '${origin}/api/query?stream=1' -H 'content-type: application/graphql' -d '
{ tcp(data: true) { daddr dport len srtt } }
| context   { const peers = {}; }
| transform { const k = $.daddr + ":" + $.dport; const p = peers[k] ??= { packets: 0, bytes: 0 }; p.packets++; p.bytes += $.len; return { peer: k, packets: p.packets, bytes: p.bytes, srtt_ms: $.srtt == null ? null : Math.round($.srtt / 80) / 100 }; }'`,
    },
    {
      what: "requests and bytes by URL path: the request line is read from the payload, the transform keeps a count per method and path",
      cmd: `curl -sN '${origin}/api/query?stream=1' -H 'content-type: application/graphql' -d '
{ tcp(ports: [80], data: true) { daddr len req: payload(len: 160, kind: text) } }
| context   { const paths = {}; }
| transform { const m = /^(GET|POST|PUT|DELETE|HEAD|PATCH) (\\S+) HTTP/.exec($.req ?? ""); if (!m) return null; const k = m[1] + " " + m[2]; const p = paths[k] ??= { requests: 0, bytes: 0 }; p.requests++; p.bytes += $.len; return { route: k, to: $.daddr, requests: p.requests, bytes: p.bytes }; }'`,
    },
    {
      what: "Jellyfin on this host (port 8096): what each client has been served, in MB, and the request behind it",
      cmd: `curl -sN '${origin}/api/query?stream=1' -H 'content-type: application/graphql' -d '
{ tcp(ports: [8096], data: true) { hook comm daddr len req: payload(len: 120, kind: text) } }
| context   { const served = {}; }
| transform { if ($.hook === "tx" && $.comm !== "curl") served[$.daddr] = (served[$.daddr] ?? 0) + $.len; const m = /^(GET|POST) (\\S+) HTTP/.exec($.req ?? ""); if (!m && $.hook !== "tx") return null; return { client: $.daddr, mb: Math.round((served[$.daddr] ?? 0) / 1e4) / 100, asked: m ? m[2].replace(/\\?.*$/, "") : null }; }'`,
    },
    {
      what: "one shot, JSON, five rows or two seconds",
      cmd: `curl -s ${origin}/api/query -H 'content-type: application/graphql' -d '{ tcp(limit: 5, ms: 2000) { hook daddr dport cwnd } }'`,
    },
    {
      what: "the contract, for an agent",
      cmd: `curl -s ${origin}/api`,
    },
    {
      what: "ask the agent",
      cmd: `curl -sN '${origin}/api/chat?stream=1' -d 'who is this box talking to?'`,
    },
  ];
  return (
    <div class="space-y-2 text-xs" data-try>
      <For each={examples}>
        {(ex) => (
          <div>
            <div class="text-fg">{ex.what}</div>
            <CodeView lang="sh" text={ex.cmd} wrap />
          </div>
        )}
      </For>
    </div>
  );
}
