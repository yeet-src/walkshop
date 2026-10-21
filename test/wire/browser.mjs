#!/usr/bin/env node
/* Loads the query page as a browser would: the served HTML in jsdom,
 * the real client and island bundles, a real WebSocket to the hub.
 * Then types nothing, clicks [run], and reports what the DOM holds —
 * the editor's coloured spans (browser) and the result tables
 * (isolate). Needs `npm run dev` on --port (default 3600).
 *
 *   node test/wire/browser.mjs [--port 3600] [--path /query] [--seconds 8]
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { JSDOM, VirtualConsole } = await import("jsdom");

const at = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(at("--port", 3600));
const path = at("--path", "/query");
const base = `http://127.0.0.1:${port}`;

const html = await fetch(`${base}${path}`, { headers: { accept: "text/html" } }).then((r) => r.text());
const client = await fetch(`${base}/@yeetkit/client.js`).then((r) => r.text());
const islands = await fetch(`${base}/@yeetkit/islands.js`).then((r) => r.text());

const errors = [];
const vc = new VirtualConsole();
vc.on("error", (e) => errors.push(String(e?.stack ?? e)));
/* jsdom has no canvas: its "not implemented" note for getContext is expected here. */
vc.on("jsdomError", (e) => {
  if (/not implemented.*(getContext|scrollTo|scrollIntoView)/i.test(String(e?.message ?? e))) return;
  errors.push(String(e?.stack ?? e));
});
const dom = new JSDOM(html, { url: `${base}${path}`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "Text", "Comment", "DocumentFragment", "MutationObserver", "navigator", "location", "getComputedStyle", "SVGElement", "HTMLTemplateElement", "KeyboardEvent", "MouseEvent", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement"]) {
  if (window[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  } catch {
    /* getter-only globals */
  }
}
process.on("uncaughtException", (e) => errors.push(`uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => errors.push(`unhandled: ${e?.stack ?? e}`));
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.performance ??= window.performance;
window.WebSocket = globalThis.WebSocket;
window.__yeetkitIslands = "/@yeetkit/islands.js";

const dir = await mkdtemp(join(tmpdir(), "walkshop-browser-"));
await writeFile(join(dir, "islands.js"), islands);
const islandsUrl = JSON.stringify(pathToFileURL(join(dir, "islands.js")).href);
await writeFile(join(dir, "client.js"), client.replaceAll("window.__yeetkitIslands", islandsUrl).replaceAll('"/@yeetkit/islands.js"', islandsUrl));
window.console = console;
const { connect } = await import(pathToFileURL(join(dir, "client.js")).href);
const boot = /connect\(([\s\S]*?)\);\s*<\/script>/.exec(html)?.[1] ?? "";
const viewPort = /:(\d+)\/`\s*\}/.exec(boot)?.[1] ?? null;
connect(`ws://127.0.0.1:${port}/@yeetkit/ws`, window.document.getElementById("app"), viewPort ? { view: `ws://127.0.0.1:${viewPort}/` } : undefined);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = window.document;
const textOf = () => doc.body.textContent.replace(/\s+/g, " ").trim();
const button = (re) => [...doc.querySelectorAll("button")].find((b) => re.test(b.textContent));
const type = async (q) => {
  const area = doc.querySelector("textarea");
  area.value = q;
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(100);
};
const held = () => Number(doc.querySelector("[data-rows]")?.dataset.rows ?? -1);
const tabLine = () => [...doc.querySelectorAll("button[data-tab]")].map((b) => b.textContent.trim()).join(" ");
const noteOf = () => [...doc.querySelectorAll("span.text-red")].map((s) => s.textContent.trim()).find(Boolean) ?? "(none)";

await wait(3000);
if (path === "/chat") {
  /* one real model turn: ask, wait for the reply and its blocks */
  const input = doc.querySelector("[data-chat-input]");
  const prompt = at("--ask", "srtt per peer, live");
  console.log(`chat: input ${input ? "present" : "MISSING"}; asking: ${prompt}`);
  input.value = prompt;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const deadline = Date.now() + Number(at("--seconds", 60)) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await wait(1000);
    const reply = [...doc.querySelectorAll("[data-message][data-role='assistant']")].pop();
    const blocks = [...(reply?.querySelectorAll("[data-block]") ?? [])];
    const drawn = blocks.filter((b) => b.querySelector("svg, table, canvas, .text-lg")).length;
    const open = reply?.querySelectorAll("[data-open-block]").length ?? 0;
    const srcShown = blocks.filter((b) => b.querySelector("pre")).length;
    const line = `reply: ${reply ? reply.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "(none)"} | open ${open}, blocks ${blocks.length}, drawn ${drawn}, source visible ${srcShown}`;
    if (line !== last) console.log(`  ${Math.round((Date.now() - (deadline - Number(at("--seconds", 60)) * 1000)) / 1000)}s ${line}`);
    last = line;
    const done = reply && reply.dataset.status === "done" && blocks.length && drawn === blocks.length;
    if (done) {
      await wait(4000);
      const after = [...reply.querySelectorAll("[data-block]")].map((b) => `${b.dataset.object}: ${b.textContent.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      console.log(`  blocks after 4 s more: ${after.join(" || ")}`);
      for (const b of reply.querySelectorAll("[data-block]")) {
        const fold = [...b.querySelectorAll("button")].find((x) => /\] source/.test(x.textContent))?.textContent.trim();
        console.log(`  block ${b.dataset.object}: widget ${Boolean(b.querySelector("svg, table, canvas, .text-lg"))}, pre ${b.querySelectorAll("pre").length} (${[...b.querySelectorAll("pre")].map((p) => p.textContent.split("\n")[0].slice(0, 30)).join(" | ")}), fold ${fold ?? "(none)"}, error ${Boolean(b.querySelector(".text-red"))}`);
      }
      const pre = reply.querySelector("[data-block] pre");
      console.log(`  source hidden once drawn: ${!pre}; toggles back: ${(() => { [...reply.querySelectorAll("button")].find((b) => /\] source/.test(b.textContent))?.click(); return Boolean(reply.querySelector("[data-block] pre")); })()}`);
      const cls = {};
      for (const sp of pre?.querySelectorAll("span") ?? []) for (const c of sp.className.split(" ")) if (c) cls[c] = (cls[c] ?? 0) + 1;
      console.log(`  source: ${pre ? `${pre.querySelectorAll("span").length} spans, classes ${JSON.stringify(cls)}; first line: ${pre.textContent.split("\n")[0]}` : "NO SOURCE"}`);
      break;
    }
  }
  console.log(`\nerrors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e.split("\n")[0]}`);
  process.exit(0);
}
if (path !== "/query") {
  /* any other page: say what rendered and stop */
  const count = (sel) => doc.querySelectorAll(sel).length;
  console.log(`${path}: ${count("*")} elements; h1 ${count("h1")}, h2 ${count("h2")}, h3 ${count("h3")}, tables ${count("table")}, code blocks ${count("pre")}, paragraphs ${count("p")}, lists ${count("ul")}`);
  console.log(`headings: ${[...doc.querySelectorAll("h2, h3")].map((h) => h.textContent.trim()).join(" · ")}`);
  console.log(`text: ${textOf().slice(0, Number(at("--chars", 300)))}`);
  console.log(`\nerrors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e.split("\n")[0]}`);
  process.exit(0);
}
console.log(`island: textarea ${doc.querySelector("textarea") ? "present" : "MISSING"}; mirror spans ${doc.querySelectorAll("pre span").length}; tabs: ${tabLine()}`);

/* tab 1: a text and a bytes window */
await type(`{ tcp(ports: [80], data: true) { hook comm daddr dport len cwnd req: payload(len: 120) raw: payload(len: 40, kind: bytes) } }`);
button(/\[run\]/)?.click();
await wait(3500);
const t1a = held();
console.log(`tab 1 after 3.5 s: ${t1a} rows; note: ${noteOf()}; tabs: ${tabLine()}; rows pushed over the console lane: ${window.__walkshopPushed?.() ?? "n/a"}`);
{
  const box = doc.querySelector("[data-rows]");
  const seqs = [...(box?.querySelectorAll("tr[data-seq]") ?? [])].map((tr) => Number(tr.dataset.seq));
  const cellsW = [...(box?.querySelectorAll("td[data-window]") ?? [])];
  console.log(`  ${seqs.length} drawn, newest first: ${seqs.every((v, i) => !i || v < seqs[i - 1])}; window cells ${cellsW.length} (${cellsW.length === seqs.length * 2 ? "two per row" : "MISMATCH"})`);
  console.log(`  head: ${box?.querySelector("thead")?.textContent.trim().replace(/\s+/g, " ")}`);
  const times = [...box.querySelectorAll("td[data-time]")].map((td) => td.textContent);
  console.log(`  time column: ${times.slice(0, 3).join(" | ")} (${/^\d\d:\d\d:\d\d\.\d{6}$/.test(times[0] ?? "") ? "HH:MM:SS.µs" : "BAD FORMAT"}, descending: ${times.every((t, i) => !i || t <= times[i - 1])})`);
  const reqCell = cellsW.find((td) => td.dataset.window === "req" && /HTTP|GET/.test(td.textContent));
  const rawCell = cellsW.find((td) => td.dataset.window === "raw" && /48 54|47 45/.test(td.textContent));
  console.log(`  req cell: ${reqCell?.textContent} [${reqCell?.className.replace("pr-4 font-mono ", "")}]; raw cell: ${rawCell?.textContent.slice(0, 60)} [${rawCell?.className.replace("pr-4 font-mono ", "")}]`);
  const asText = cellsW.filter((td) => td.dataset.window === "req" && td.className.includes("text-pink")).length;
  const asDump = cellsW.filter((td) => td.dataset.window === "req" && td.className.includes("text-yellow")).length;
  console.log(`  auto on port 80: ${asText} rows as text, ${asDump} rows as dump`);
  (reqCell?.closest("tr") ?? box.querySelector("tr[data-seq]"))?.click();
  await wait(200);
  const insp = doc.querySelector("[data-inspector]");
  const preI = insp?.querySelector("pre");
  console.log(`  inspector: opened ${Boolean(insp)}; text lines ${preI ? preI.textContent.split("\n").length : 0}; xxd lines ${insp ? insp.querySelectorAll("div.whitespace-pre").length : 0}`);
  const seq0 = Number(insp?.dataset.inspector);
  {
    /* cells must survive polls: a rebuilt cell is a detached old node */
    const probeRow = [...box.querySelectorAll("tr[data-seq]")][3];
    const probeCell = probeRow?.querySelector("td");
    const probeTime = probeRow?.querySelector("td[data-time]")?.textContent;
    await wait(2200);
    console.log(`  stable DOM over 2.2 s: cell still attached ${probeCell?.isConnected === true}, time text unchanged ${probeRow?.querySelector("td[data-time]")?.textContent === probeTime}`);
  }
  {
    const other = [...box.querySelectorAll("tr[data-seq]")].find((tr) => Number(tr.dataset.seq) !== seq0);
    other?.click();
    await wait(200);
    const now = Number(doc.querySelector("[data-inspector]")?.dataset.inspector);
    console.log(`  click another row while one is picked: ${seq0} → ${now} (${now === Number(other?.dataset.seq) ? "switched" : "DID NOT SWITCH"})`);
    box.querySelector(`tr[data-seq="${seq0}"]`)?.click();
    await wait(200);
  }
  {
    /* anchored while picked: the picked row stays rendered and the scroll grows with arrivals */
    const held0 = held();
    const top0 = box.scrollTop;
    await wait(2500);
    const grew = held() - held0;
    const still = Boolean(box.querySelector(`tr[data-seq="${seq0}"]`));
    console.log(`  anchored: ${grew} packets arrived while picked; scroll ${top0} → ${box.scrollTop} (${box.scrollTop - top0 === grew * 20 ? "followed" : "DID NOT FOLLOW"}); picked row still rendered: ${still}`);
  }
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait(150);
  const seq1 = Number(doc.querySelector("[data-inspector]")?.dataset.inspector);
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await wait(150);
  const seq2 = Number(doc.querySelector("[data-inspector]")?.dataset.inspector);
  console.log(`  arrows: ${seq0} → down → ${seq1} (${seq1 < seq0 ? "older" : "NOT older"}) → up → ${seq2} (${seq2 === seq0 ? "back" : "NOT back"})`);
  const inspEl = doc.querySelector("[data-inspector]");
  const h0 = inspEl?.style.height;
  const handle = inspEl?.querySelector("[data-resize-inspector]");
  handle?.dispatchEvent(new window.MouseEvent("mousedown", { clientY: 500, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { clientY: 400, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await wait(150);
  console.log(`  resize: ${h0} → ${doc.querySelector("[data-inspector]")?.style.height} after dragging the edge up 100px; top border: ${inspEl?.className.includes("border-t border-fg")}`);
  doc.querySelector("[data-inspector] [data-close-inspector]")?.click();
  await wait(200);
  console.log(`  closed by ×: ${!doc.querySelector("[data-inspector]")}`);
}

/* tab 2: a second run on the same root, at the same time */
button(/^\[\+\]$/)?.click();
await wait(200);
await type(`{ udp { hook } struct(name: "udphdr") { name } }`);
console.log(`tab names follow the editor while idle: ${tabLine()}`);
await type(`{ tcp(ports: [80]) { hook saddr dport ttl window len } }
| context { let n = 0; const bytes = {}; }
| transform { if ($.len === 0) return null; bytes[$.saddr] = (bytes[$.saddr] ?? 0) + $.len; $.n = ++n; $.total = bytes[$.saddr]; }`);
button(/\[run\]/)?.click();
await wait(3500);
const t2a = held();
console.log(`tab 2 after 3.5 s: ${t2a} rows; note: ${noteOf()}; tabs: ${tabLine()}`);
{
  const box = doc.querySelector("[data-rows]");
  const head = box?.querySelector("thead")?.textContent.trim().replace(/\s+/g, " ");
  const first = box?.querySelector("tr[data-seq]");
  const cells = first ? [...first.querySelectorAll("td")].map((td) => td.textContent) : [];
  console.log(`  pipeline: head: ${head}; first row: ${cells.join(",")}; bare ACKs dropped: ${![...(box?.querySelectorAll("tr[data-seq]") ?? [])].some((tr) => [...tr.querySelectorAll("td")][5]?.textContent === "0")}`);
}

/* back to tab 1: still running, still growing */
button(/^\[1 /)?.click();
await wait(300);
const t1b = held();
await wait(2000);
const t1c = held();
console.log(`tab 1 again: ${t1b} → ${t1c} rows (${t1c > t1b ? "growing" : "STUCK"}); button: ${button(/\[(run|stop)\]/)?.textContent.trim()}`);

/* stop tab 1; tab 2 keeps going */
button(/\[stop\]/)?.click();
await wait(1500);
console.log(`after stop: tab 1 button ${button(/\[(run|stop)\]/)?.textContent.trim()}; tabs: ${tabLine()}`);
button(/^\[2 /)?.click();
await wait(300);
const t2b = held();
await wait(2000);
const t2c = held();
console.log(`tab 2 again: ${t2b} → ${t2c} rows (${t2c > t2b ? "growing" : "STUCK"})`);

/* tab 3: more fields than the VM has left */
button(/^\[\+\]$/)?.click();
await wait(200);
await type(`{ tcp { cwnd srtt mss rto ca rcvbuf sndbuf mtu } }`);
button(/\[run\]/)?.click();
await wait(1500);
console.log(`tab 3 (8 more fields): note: ${noteOf()}; errors shown: ${[...doc.querySelectorAll("ul.text-red li")].map((li) => li.textContent.slice(0, 80)).join(" | ")}`);
[...doc.querySelectorAll("button")].filter((b) => b.textContent.trim() === "×").pop()?.click();
await wait(300);
console.log(`after closing tab 3: tabs: ${tabLine()}`);

/* tab 4: auto on TLS traffic shows dumps */
button(/^\[\+\]$/)?.click();
await wait(200);
await type(`{ tcp(ports: [443], data: true) { hook dport len req: payload() } }`);
button(/\[run\]/)?.click();
await wait(3500);
{
  const box = doc.querySelector("[data-rows]");
  const reqCells = [...(box?.querySelectorAll("td[data-window='req']") ?? [])];
  const asText = reqCells.filter((td) => td.className.includes("text-pink")).length;
  const asDump = reqCells.filter((td) => td.className.includes("text-yellow")).length;
  console.log(`auto on port 443: ${held()} rows held, ${asText} as text, ${asDump} as dump; note: ${noteOf()}; a dump cell: ${reqCells.find((td) => td.className.includes("text-yellow"))?.textContent.slice(0, 60)}`);
}
[...doc.querySelectorAll("button")].filter((b) => b.textContent.trim() === "×").pop()?.click();
await wait(300);

/* the fold */
button(/\] query/)?.click();
await wait(100);
console.log(`query fold: editor hidden ${!doc.querySelector("textarea")}, run still shown ${Boolean(button(/\[(run|stop)\]/))}`);

console.log(`ops fold shown: ${Boolean(button(/what the kernel ran/))} (hidden for now)`);

console.log(`\nerrors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log(`  ${e.split("\n")[0]}`);
process.exit(0);
