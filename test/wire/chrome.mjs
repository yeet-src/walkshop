#!/usr/bin/env node
/* The chat in a real headless Chrome over the DevTools protocol, since
 * a canvas cannot be read from jsdom: load /chat, ask for a canvas,
 * wait for it, count the pixels it painted, and save a screenshot.
 *
 *   node test/wire/chrome.mjs [--port 3700] [--ask "draw the packet rate on a canvas"] [--out shot.png]
 */
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const at = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(at("--port", 3700));
const ask = at("--ask", "draw the packet rate on a canvas");
const out = at("--out", ".build/chat.png");
const browser = at("--browser", "google-chrome-stable");
const debugPort = 9333 + Math.floor(Math.random() * 100);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(browser, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--window-size=${at("--width", 1300)},${at("--height", 1000)}`, "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${tmpdir()}/walkshop-chrome-profile`, "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
process.on("exit", () => chrome.kill("SIGTERM"));

let targets = null;
for (let i = 0; i < 50 && !targets; i += 1) {
  await wait(200);
  targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).catch(() => null);
}
const page = targets?.find((t) => t.type === "page");
if (!page) {
  console.log("chrome did not come up");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const pending = new Map();
const thrown = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") thrown.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") thrown.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (m.method === "Log.entryAdded" && (m.params.entry.level === "error" || m.params.entry.level === "warning")) thrown.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Log.enable");
await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/chat` });
for (let i = 0; i < 160; i += 1) {
  await wait(250);
  if (await evaluate(`Boolean(document.querySelector("[data-chat-input]"))`)) break;
}
console.log(`chat page: input ${await evaluate(`Boolean(document.querySelector("[data-chat-input]"))`)}; model line: ${await evaluate(`document.querySelector("[data-model]")?.textContent ?? ""`)}`);

/* Type the question the way a person would. */
await evaluate(`document.querySelector("[data-chat-input]").focus()`);
await cdp("Input.insertText", { text: ask });
await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

const seen = new Set();
let painted = null;
for (let i = 0; i < (ask ? 120 : 0); i += 1) {
  await wait(1000);
  const sp = await evaluate(`(() => { const s = document.querySelector("[data-spinner]"); return s ? s.textContent.trim() : null; })()`);
  if (sp) seen.add(sp.split(" ").slice(0, 2).join(" ").replace(/^\S+ /, ""));
  if (sp && i < 4) {
    await wait(130);
    console.log(`  spinner: ${sp} → ${await evaluate(`document.querySelector("[data-spinner]")?.textContent.trim() ?? "(gone)"`)}`);
  }
  painted = await evaluate(`(() => {
    const c = document.querySelector("[data-block] canvas");
    if (!c) return null;
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60 || d[i + 3] === 0) lit++;
    return { w: c.width, h: c.height, lit, total: d.length / 4 };
  })()`);
  if (painted && painted.lit > 50) break;
}
const status = await evaluate(`[...document.querySelectorAll("[data-message][data-role='assistant']")].pop()?.dataset.status ?? "(none)"`);
console.log(`header: ${await evaluate(`document.querySelector("[data-agent-status]")?.textContent.replace(/\\s+/g, " ").trim()`)}`);
const steps = await evaluate(`(() => { const s = document.querySelector("[data-steps]"); return s ? { state: s.dataset.steps, head: s.querySelector("button")?.textContent.trim(), spans: s.querySelectorAll("pre span").length } : null; })()`);
console.log(`steps: ${JSON.stringify(steps)}`);
const blocks = await evaluate(`[...document.querySelectorAll("[data-block]")].map((b) => b.dataset.object)`);
console.log(`reply status ${status}; blocks ${JSON.stringify(blocks)}; spinner phases seen: ${[...seen].join(", ") || "(none)"}; spinner now: ${await evaluate(`Boolean(document.querySelector("[data-spinner]"))`)}`);
console.log(painted ? `canvas ${painted.w}x${painted.h}: ${painted.lit} of ${painted.total} pixels painted (${((100 * painted.lit) / painted.total).toFixed(1)}%)` : "NO canvas rendered");
console.log(`chart: ${JSON.stringify(await evaluate(`(() => { const c = document.querySelector("[data-chart]"); if (!c) return "none"; return { canvases: c.querySelectorAll("canvas").length, legend: document.querySelector("[data-legend]")?.textContent.replace(/\\s+/g, " ").trim().slice(0, 140) }; })()`))}`);

/* The dashboard: pin whatever is not pinned, open the overlay, count the tiles. */
{
  const pinButtons = await evaluate(`[...document.querySelectorAll("[data-pin]")].filter((b) => b.textContent.includes("[pin]")).length`);
  await evaluate(`[...document.querySelectorAll("[data-pin]")].filter((b) => b.textContent.includes("[pin]")).forEach((b) => b.click())`);
  await wait(1500);
  await evaluate(`document.querySelector("[data-dash-toggle]")?.click()`);
  await wait(1500);
  const tiles = await evaluate(`(() => { const d = document.querySelector("[data-dashboard]"); if (!d) return null; return { tiles: d.querySelectorAll("[data-tile]").length, canvases: d.querySelectorAll("canvas").length, cols: getComputedStyle(d.querySelector("[data-grid]") ?? d).gridTemplateColumns.split(" ").length, toggle: document.querySelector("[data-dash-toggle]")?.textContent.trim() }; })()`);
  console.log(`dashboard: clicked ${pinButtons} pin buttons; ${JSON.stringify(tiles)}`);
  const md = await evaluate(`(() => { const c = document.querySelector("[data-dash-latest]"); if (!c) return null; const n = (sel) => c.querySelectorAll(sel).length; return { p: n("p"), b: n("b"), code: n("code"), ul: n("ul"), li: n("li"), chips: n(".border.border-rule.px-1") }; })()`);
  console.log(`corner markdown: ${JSON.stringify(md)}`);
}
/* The corner panel: drag its handle 200 px left and 150 px up. */
{
  const h = await evaluate(`(() => { const h = document.querySelector("[data-corner-handle]"); if (!h) return null; const r = h.getBoundingClientRect(); const p = h.parentElement.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2, left: p.left, top: p.top }; })()`);
  if (h) {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: h.x, y: h.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x - 100, y: h.y - 75, button: "left" });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x - 200, y: h.y - 150, button: "left" });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: h.x - 200, y: h.y - 150, button: "left", clickCount: 1 });
    await wait(200);
    const after = await evaluate(`(() => { const p = document.querySelector("[data-dash-latest]").getBoundingClientRect(); return { left: p.left, top: p.top, saved: localStorage.getItem("walkshop.corner") }; })()`);
    console.log(`corner drag: ${Math.round(h.left)},${Math.round(h.top)} → ${Math.round(after.left)},${Math.round(after.top)} (${Math.round(h.left - after.left) === 200 && Math.round(h.top - after.top) === 150 ? "moved by the drag" : "DID NOT MOVE AS DRAGGED"}); saved ${after.saved}`);
  } else console.log("corner handle: MISSING");
}
const then = at("--then", "");
if (then) {
  /* a second request while the dashboard is up: the agent should work the board */
  await evaluate(`document.querySelector("[data-chat-input]").focus()`);
  await cdp("Input.insertText", { text: then });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  for (let i = 0; i < 90; i += 1) {
    await wait(1000);
    const st = await evaluate(`[...document.querySelectorAll("[data-message][data-role='assistant']")].pop()?.dataset.status`);
    if (st === "done" || st === "error") break;
  }
  await wait(1500);
  const after = await evaluate(`(() => { const d = document.querySelector("[data-dashboard]"); return { overlayOpen: Boolean(d), tiles: [...(d?.querySelectorAll("[data-tile]") ?? [])].map((t) => (t.querySelector(".text-yellow")?.textContent.trim() ?? "?") + " span " + t.style.gridColumn), latest: d?.querySelector("[data-dash-latest]")?.textContent.replace(/\\s+/g, " ").trim().slice(0, 200) }; })()`);
  console.log(`after "${then}": ${JSON.stringify(after)}`);
}
/* Let a live block run a few more times before the shot. */
await wait(Number(at("--settle", 0)));
/* `--eval <js>`: anything else worth asking the page, printed as JSON. */
const probe = at("--eval", "");
if (probe) console.log(`eval: ${JSON.stringify(await evaluate(probe))}`);
/* Scroll the canvas into view and shoot it. */
await evaluate(`document.querySelector("[data-block] canvas")?.scrollIntoView({ block: "center" })`);
await wait(500);
const shot = await cdp("Page.captureScreenshot", { format: "png" });
await writeFile(out, Buffer.from(shot.data, "base64"));
console.log(`screenshot: ${out}`);
console.log(`page exceptions: ${thrown.length}`);
for (const t of thrown.slice(0, 5)) console.log(`  ${String(t).split("\n")[0].slice(0, 200)}`);
ws.close();
chrome.kill("SIGTERM");
process.exit(0);
