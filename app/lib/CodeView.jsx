/* A block of code, coloured for its language, with a copy button in
 * its corner. Browser side; Code.jsx is the island wrapper for a page
 * rendered in the isolate. */
import { createSignal, For } from "solid-js";

import { CODE_CLASS, highlight } from "./code.js";

export default function CodeView(props) {
  const [copied, setCopied] = createSignal(false);
  let pre;
  /* The async clipboard exists only in a secure context — https, or
   * localhost — so on http://goofy:3600 it is undefined. Then select the
   * text and use the old copy command, which still works everywhere. */
  const copy = async () => {
    const text = String(props.text ?? "");
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (!ok && pre) {
      /* last resort: leave the block selected for a manual copy */
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setCopied(ok ? "copied" : "select and copy");
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class="relative group" data-code={props.lang ?? ""}>
      <button class="absolute right-1 top-1 text-xs text-dim hover:text-fg opacity-60 group-hover:opacity-100" onClick={copy} data-copy>
        {() => (copied() ? `[${copied()}]` : "[copy]")}
      </button>
      <pre ref={pre} class={`overflow-x-auto border border-dim p-2 pr-16 text-xs ${props.wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
        <For each={highlight(props.lang, props.text)}>{(t) => <span class={CODE_CLASS[t.kind] ?? ""}>{t.text}</span>}</For>
      </pre>
    </div>
  );
}
