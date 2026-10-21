"use client";

/* The first requests to make against this host, written for wherever
 * the page was opened from: the isolate knows only the path, so this
 * runs in the browser and reads the origin. Each line is one click to
 * copy. */
import { createSignal, For } from "solid-js";

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
  const [copied, setCopied] = createSignal(-1);
  const copy = async (i, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied(-1), 1200);
    } catch {
      /* no clipboard here: the text is selectable */
    }
  };
  return (
    <div class="space-y-2 text-xs" data-try>
      <For each={examples}>
        {(ex, i) => (
          <div>
            <div class="text-dim">
              # {ex.what}
              <button class="ml-2 hover:text-fg" onClick={() => copy(i(), ex.cmd)}>
                {() => (copied() === i() ? "[copied]" : "[copy]")}
              </button>
            </div>
            <pre class="whitespace-pre-wrap break-all text-green">{ex.cmd}</pre>
          </div>
        )}
      </For>
    </div>
  );
}
