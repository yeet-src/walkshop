/* The docs, typeset: a small renderer for the Markdown this app writes
 * — headings, paragraphs, lists, tables, fenced code, inline code and
 * bold. Nothing is interpreted as HTML. Runs in the isolate. */
import { For } from "yeetkit";

/* Inline: `code` and **bold**, left to right. */
function inline(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code class="text-cyan">{t.slice(1, -1)}</code>);
    else out.push(<b class="text-fg">{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* Blocks, line by line. */
function blocks(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang, body: body.join("\n") });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) {
      out.push({ t: `h${h[1].length}`, text: h[2] });
      i++;
      continue;
    }
    if (l.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push({ t: "table", head, body });
      continue;
    }
    if (/^(\d+\.|-)\s/.test(l)) {
      const items = [];
      while (i < lines.length && (/^(\d+\.|-)\s/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^(\d+\.|-)\s/.test(lines[i])) items.push(lines[i].replace(/^(\d+\.|-)\s/, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      out.push({ t: l.startsWith("-") ? "ul" : "ol", items });
      continue;
    }
    if (l.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|```|\||-\s|\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    out.push({ t: "p", text: para.join(" ") });
  }
  return out;
}

export default function Markdown(props) {
  return (
    <div class="max-w-4xl space-y-3 text-sm">
      <For each={blocks(props.text)}>
        {(b) => {
          switch (b.t) {
            case "h1":
              return <h1 class="comment text-base">{b.text}</h1>;
            case "h2":
              return <h2 class="comment mt-6">{b.text}</h2>;
            case "h3":
              return <h3 class="text-yellow mt-4">{b.text}</h3>;
            case "code":
              return <pre class="overflow-x-auto border border-dim p-2 text-xs text-green whitespace-pre">{b.body}</pre>;
            case "table":
              return (
                <table class="text-left text-xs">
                  <thead class="text-yellow">
                    <tr>
                      <For each={b.head}>{(c) => <th class="pr-6 font-normal align-top">{inline(c)}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={b.body}>
                      {(r) => (
                        <tr>
                          <For each={r}>{(c) => <td class="pr-6 align-top text-dim">{inline(c)}</td>}</For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              );
            case "ul":
            case "ol":
              return (
                <ul class="list-disc pl-5 space-y-1 text-dim">
                  <For each={b.items}>{(it) => <li>{inline(it)}</li>}</For>
                </ul>
              );
            default:
              return <p class="text-dim max-w-prose">{inline(b.text)}</p>;
          }
        }}
      </For>
    </div>
  );
}
