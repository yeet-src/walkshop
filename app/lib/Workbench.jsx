"use client";

/* The query workbench: tabs, one per run; an editor for the active
 * tab; its rows, newest first, virtualised, with an inspector.
 *
 * Runs in the browser. Every run lives in the isolate (session.js)
 * and keeps going until stopped, whichever browser started it; this
 * island shows them as tabs, polls the active one for what is new,
 * and lists the runs every couple of seconds so a tab opened elsewhere
 * appears here too. Which tab is active, the editor's text, the
 * folds, the scroll — those are yours alone.
 *
 * The editor is a textarea with transparent text over a mirror
 * coloured by the query's own tokens. The table is a fixed-height-row
 * list with a spacer above and below the window, so the scrollbar is
 * the real length and only the rows in view exist. A window column
 * (payload, at, a text or bytes read) goes on its own lines under the
 * row — text as text, bytes as a coloured xxd dump — so a row is a
 * fixed number of lines and the virtual list holds. Click a row and
 * the inspector shows the full dump. */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { close, list, poll, start, stop } from "./actions.js";
import { openLane } from "./laneClient.js";
import { format } from "./gql/format.js";
import { parse } from "./gql/parse.js";
import { lines } from "./gql/tokens.js";
import { looksText, textOf, xxd } from "./hex.js";

const ROW = 20; /* px; text-xs with leading-5 */
const OVERSCAN = 8;
const MIN_VIEW = 200;
const HEADING = 32;
const INSPECTOR = 0.4; /* the inspector's first share of the view; drag its top edge after that */
const INSPECTOR_MIN = 80;
const SHOW_OPS = false;

const TOKEN_CLASS = {
  root: "text-magenta",
  base: "text-blue",
  leaf: "text-fg",
  alias: "text-cyan",
  arg: "text-dim",
  value: "text-green",
  directive: "text-yellow",
  keyword: "text-dim",
  string: "text-green",
  number: "text-cyan",
  comment: "text-dim italic",
  punct: "text-dim",
  error: "bg-red text-bg",
  space: "",
  stage: "text-magenta",
  js: "text-fg",
};

const KIND_CLASS = {
  ip4: "text-cyan", ip6: "text-cyan", mac: "text-cyan",
  port: "text-blue", be: "text-blue",
  str: "text-green", text: "text-pink", auto: "text-pink", json: "text-pink",
  enum: "text-magenta", bool: "text-magenta",
  bytes: "text-yellow", hex: "text-yellow",
  ptr: "text-dim",
  uint: "text-fg", int: "text-fg",
};

const classOf = (c, v) => (v == null ? "text-dim" : c.kind === "hook" ? (v === "tx" ? "text-yellow" : "text-cyan") : (KIND_CLASS[c.kind] ?? "text-fg"));
const cell = (v) => (v == null ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

/* A packet's time of day to the microsecond. `_ts` is the kernel's
 * monotonic clock in ns; the run's offset to wall time is taken from
 * the first row (host arrival minus kernel time) and then applied to
 * every row, so packets keep the kernel's spacing rather than the
 * poll's. */
const pad = (n, w) => String(n).padStart(w, "0");
function timeOf(row, offsetMs) {
  if (row._ts == null || offsetMs == null) return "–";
  const us = Number(BigInt(row._ts) / 1000n);
  const ms = offsetMs + us / 1000;
  const d = new Date(ms);
  const micro = Math.round((ms - Math.floor(ms)) * 1000) + d.getMilliseconds() * 1000;
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(Math.min(999999, micro), 6)}`;
}
/* Wall time minus kernel time, from one row — the first a run shows,
 * and then held for the run, so no time cell is ever rewritten. */
const offsetOf = (rows) => {
  const r = rows.find((x) => x._ts != null && x._at != null);
  return r ? r._at - Number(BigInt(r._ts) / 1000n) / 1000 : null;
};
/* How a window shows: text, a dump, or — for `auto` — whichever the
 * bytes look like. In the row it is one cell, clipped: the first line
 * of the text, or the first bytes of the dump; the inspector has it
 * all, with line breaks and the whole dump. */
const showAs = (c, row) => (c.kind === "bytes" ? "dump" : c.kind === "auto" ? (looksText(row._raw?.[c.key] ?? "") ? "text" : "dump") : "text");
const isText = (c) => c.window && c.kind !== "bytes";
const CELL_BYTES = 24;
const CELL_CHARS = 96;
function windowCell(c, row) {
  const hex = row._raw?.[c.key];
  if (!hex) return { cls: "text-dim", text: row._len === 0 ? "– no payload" : "– not readable" };
  if (showAs(c, row) === "dump") {
    const n = hex.length / 2;
    const pairs = [];
    for (let i = 0; i < Math.min(n, CELL_BYTES); i++) pairs.push(hex.slice(i * 2, i * 2 + 2));
    return { cls: "text-yellow", text: `${pairs.join(" ")}${n > CELL_BYTES ? ` … ${n} bytes` : ""}` };
  }
  const t = textOf(hex);
  const nl = t.indexOf("\n");
  const first = nl >= 0 ? t.slice(0, nl) : t;
  const more = nl >= 0 ? " ⏎…" : first.length > CELL_CHARS ? "…" : "";
  return { cls: KIND_CLASS[c.kind] ?? "text-pink", text: first.slice(0, CELL_CHARS) + more };
}
const brief = (text) => text.replace(/\s+/g, " ").trim();
/* A query's name for a tab: its roots, joined — `tcp`, `tcp+udp`,
 * `struct`. From the parser when the text parses, else the first name
 * after the brace, else "query". */
const nameOf = (text) => {
  try {
    const names = parse(text).map((s) => s.alias ?? s.name);
    if (names.length) return names.join("+");
  } catch {
    /* half-typed */
  }
  const m = /\{\s*([A-Za-z_][\w]*)/.exec(text ?? "");
  return m ? m[1] : "query";
};

function XxdLine(props) {
  return (
    <div class="whitespace-pre">
      <span class="text-dim">{props.line.offset}: </span>
      <For each={props.line.cells}>{(b, i) => (b ? <span class={b.cls}>{b.hex}{i() === 7 ? "  " : " "}</span> : <span>{i() === 7 ? "    " : "   "}</span>)}</For>
      {" "}
      <For each={props.line.ascii}>{(a) => <span class={a.cls}>{a.ch}</span>}</For>
    </div>
  );
}

export default function Workbench(props) {
  const examples = props.examples ?? {};
  const firstExample = Object.values(examples)[0] ?? "{ tcp { hook daddr dport } }";

  /* tabs: { key, runId, text } — key is local, runId the isolate's */
  const [tabs, setTabs] = createSignal([]);
  const [active, setActive] = createSignal(null);
  const [text, setText] = createSignal("");
  const [open, setOpen] = createSignal(true);
  const [showOps, setShowOps] = createSignal(false);
  const [note, setNote] = createSignal("");
  const [runs, setRuns] = createSignal({}); /* runId → { busy, count, errors } from list() */
  const [buf, setBuf] = createSignal({}); /* runId → { at, busy, roots, columns, plans, errors, meta, rows, keep } */
  const [scroll, setScroll] = createSignal({});
  const [view, setView] = createSignal(480);
  const [picked, setPicked] = createSignal(null);
  const [inspH, setInspH] = createSignal(null); /* px, once dragged; else INSPECTOR of the view */
  const boxes = {}; /* key → the scroll container, to keep the picked row in view */
  const after = {}; /* runId → { key → seq } */
  let nextKey = 1;
  let area;
  let mirror;
  let frame;
  let timer = null;
  let lister = null;
  let inflight = false;

  /* Rows arrive two ways: pushed on the console lane as they land (direct
   * mode), and by the poll, which backfills what the socket missed and
   * carries the run's status. Both go through ingest(), which dedupes by
   * sequence and keeps the view anchored. */
  const ingest = (id, key, fresh, { keep = 500 } = {}) => {
    if (!fresh.length) return;
    const prev = buf()[id];
    if (!prev) return false;
    const have = prev.rows[key] ?? [];
    const newest = have[0]?._seq ?? 0;
    const add = fresh.filter((r) => r._seq > newest);
    if (!add.length) return;
    const l = [...add.slice().sort((a, b) => b._seq - a._seq), ...have];
    if (l.length > keep) l.length = keep;
    const rows = { ...prev.rows, [key]: l };
    const offsetMs = prev.offsetMs ?? offsetOf(add);
    setBuf({ ...buf(), [id]: { ...prev, rows, offsetMs } });
    after[id] ??= {};
    after[id][key] = Math.max(after[id][key] ?? 0, l[0]._seq);
    if (id === runId()) {
      const top = scroll()[key] ?? 0;
      if (top > 0 || picked()?.key === key) {
        const next = top + add.length * ROW;
        if (boxes[key]) boxes[key].scrollTop = next;
        setScroll({ ...scroll(), [key]: next });
      }
    }
    return true;
  };

  /* The data socket: the isolate's console lane, read by the shared
   * lane client; only the workbench's own frames are taken. */
  let closeLane = () => {};
  const [pushed, setPushed] = createSignal(0);
  const openData = () => {
    closeLane = openLane((f) => {
      if (f.op === "walkshop" && f.row) {
        setPushed(pushed() + 1);
        ingest(f.run, f.key, [f.row]);
      }
    });
  };
  const dataSocket = true; /* the poll is status and backfill */
  if (typeof window !== "undefined") window.__walkshopPushed = pushed;

  const tab = () => tabs().find((t) => t.key === active()) ?? null;
  const runId = () => tab()?.runId ?? null;
  const cur = () => (runId() != null ? buf()[runId()] : null) ?? null;
  const busy = () => Boolean(cur()?.busy ?? runs()[runId()]?.busy);
  const running = (t) => t.runId != null && Boolean(runs()[t.runId]?.busy || buf()[t.runId]?.busy);
  /* A tab is named for what it is doing: the running query while it
   * runs; otherwise what is in its editor — live, as you type. */
  const label = (t) => nameOf(running(t) ? (runs()[t.runId]?.text ?? t.text) : t.key === active() ? text() : t.text);

  const addTab = (text, runId = null) => {
    const t = { key: nextKey++, runId, text };
    setTabs([...tabs(), t]);
    return t;
  };
  const switchTo = (t) => {
    const current = tab();
    if (current) setTabs(tabs().map((x) => (x.key === current.key ? { ...x, text: text() } : x)));
    setActive(t.key);
    setText(t.text);
    setPicked(null);
    setNote("");
  };
  const newTab = () => switchTo(addTab(format(firstExample)));
  const closeTab = async (t) => {
    if (t.runId != null) {
      await close(t.runId).catch(() => {});
      setBuf((b) => {
        const n = { ...b };
        delete n[t.runId];
        return n;
      });
      delete after[t.runId];
    }
    const rest = tabs().filter((x) => x.key !== t.key);
    setTabs(rest);
    if (active() === t.key) {
      if (rest.length) switchTo(rest[rest.length - 1]);
      else newTab();
    }
  };

  /* Runs started elsewhere become tabs here; stopped ones update. */
  const syncRuns = async () => {
    try {
      const all = await list();
      const byId = {};
      for (const r of all) byId[r.id] = r;
      setRuns(byId);
      const known = new Set(tabs().map((t) => t.runId).filter((x) => x != null));
      for (const r of all) if (!known.has(r.id)) addTab(r.text, r.id);
      /* a tab whose run was closed elsewhere loses its run */
      setTabs(tabs().map((t) => (t.runId != null && !byId[t.runId] ? { ...t, runId: null } : t)));
    } catch {
      /* next time */
    }
  };

  const tick = async () => {
    if (inflight) return;
    inflight = true;
    try {
      const id = runId();
      if (id != null) {
        after[id] ??= {};
        let r = await poll(id, after[id]);
        if (r.gone) {
          setTabs(tabs().map((t) => (t.runId === id ? { ...t, runId: null } : t)));
        } else {
          const prev = buf()[id];
          if (prev && prev.at !== r.at) {
            after[id] = {};
            r = await poll(id, {});
          }
          const rows = { ...(prev && prev.at === r.at ? prev.rows : {}) };
          for (const key of r.roots) rows[key] ??= [];
          /* Keep what did not change by reference: the cells are keyed on
           * the column objects, and a fresh array every second would
           * rebuild every visible cell — a flicker at 1 Hz. */
          const keep = (next, old) => (old !== undefined && JSON.stringify(next) === JSON.stringify(old) ? old : next);
          const same = prev && prev.at === r.at ? prev : {};
          const entry = {
            at: r.at,
            busy: r.busy,
            roots: keep(r.roots, same.roots),
            columns: keep(r.columns, same.columns),
            plans: keep(r.plans, same.plans),
            errors: keep(r.errors, same.errors),
            meta: keep(r.meta, same.meta),
            rows,
            keep: r.keep,
            /* the run's clock offset, fixed from its first row */
            offsetMs: same.offsetMs ?? null,
          };
          const changed = !prev || Object.keys(entry).some((k) => k !== "rows" && entry[k] !== prev[k]);
          if (changed) setBuf({ ...buf(), [id]: entry });
          for (const key of r.roots) {
            ingest(id, key, r.rows[key] ?? [], { keep: r.keep });
            after[id][key] = Math.max(after[id][key] ?? 0, r.latest[key] ?? 0);
          }
          if (r.more) {
            inflight = false;
            return tick();
          }
          if (!prev || prev.roots.length !== r.roots.length) measure();
        }
      }
    } catch {
      /* the next tick tries again */
    } finally {
      inflight = false;
      /* With the socket carrying the rows the poll is status and backfill: once a second is plenty. */
      timer = setTimeout(tick, busy() && !dataSocket ? 250 : 1000);
    }
  };

  const measure = () => {
    if (!frame) return;
    const top = frame.getBoundingClientRect().top;
    const avail = window.innerHeight - top - 8;
    const n = Math.max(1, cur()?.roots?.length ?? 1);
    setView(Math.max(MIN_VIEW, Math.floor(avail / n) - HEADING));
  };

  const sync = () => {
    if (!area || !mirror) return;
    mirror.scrollTop = area.scrollTop;
    mirror.scrollLeft = area.scrollLeft;
  };

  const go = async () => {
    const t = tab();
    if (!t) return;
    if (busy()) {
      await stop(t.runId).catch(() => {});
      setNote("");
      return;
    }
    setNote("");
    try {
      const r = await start(t.runId, text());
      setTabs(tabs().map((x) => (x.key === t.key ? { ...x, runId: r.id, text: text() } : x)));
      after[r.id] = {};
      setBuf((b) => {
        const n = { ...b };
        delete n[r.id];
        return n;
      });
      /* The note is for trouble only; a run that starts says so by its rows. */
      setNote(r.errors?.length ? r.errors.map((e) => (e.line != null ? `line ${e.line}: ${e.message}` : e.message)).join(" · ") : "");
      clearTimeout(timer);
      tick();
    } catch (e) {
      setNote(String(e?.message ?? e));
    }
  };

  const tidy = () => {
    try {
      setText(format(text()));
      setNote("");
    } catch (e) {
      setNote(e?.line != null ? `line ${e.line}: ${e.message}` : String(e?.message ?? e));
    }
  };

  const height = () => `${Math.min(14, Math.max(4, text().split("\n").length)) + 1}rem`;

  const onKey = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      go();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "F" || event.key === "f")) {
      event.preventDefault();
      tidy();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const el = event.currentTarget;
      const { selectionStart: s, selectionEnd: e } = el;
      const next = `${el.value.slice(0, s)}  ${el.value.slice(e)}`;
      setText(next);
      el.value = next;
      el.selectionStart = el.selectionEnd = s + 2;
    }
  };

  onMount(async () => {
    await syncRuns();
    if (tabs().length) switchTo(tabs()[tabs().length - 1]);
    else newTab();
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(document.body);
    const esc = (e) => {
      if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
      if (e.key === "Escape") setPicked(null);
      else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", esc);
    onCleanup(() => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", esc);
      ro?.disconnect();
    });
    lister = setInterval(syncRuns, 2000);
    openData();
    tick();
  });
  onCleanup(() => {
    clearTimeout(timer);
    clearInterval(lister);
    closeLane();
  });

  /* ---- the table ---- */
  const cols = (key) => cur()?.columns?.[key] ?? [];
  const scalarCols = (key) => cols(key).filter((c) => !c.window);
  const windowCols = (key) => cols(key).filter((c) => c.window);
  const rowH = () => ROW;
  const rowsOf = (key) => cur()?.rows?.[key] ?? [];
  const inspectorHeight = () => Math.max(INSPECTOR_MIN, Math.min(view() - 100, inspH() ?? Math.floor(view() * INSPECTOR)));
  const tableHeight = (key) => (picked()?.key === key ? view() - inspectorHeight() : view());

  /* Drag the inspector's top edge. */
  const startResize = (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = inspectorHeight();
    const move = (ev) => setInspH(h0 - (ev.clientY - y0));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /* Up and down walk the packets: down is older (further down the
   * list), up newer. With nothing picked, down picks the newest. The
   * table scrolls so the picked row stays in view. */
  const step = (dir) => {
    const p = picked();
    const key = p?.key ?? cur()?.roots?.[0];
    if (!key) return;
    const list = rowsOf(key);
    if (!list.length) return;
    let i = p ? list.findIndex((r) => r._seq === p.seq) : -1;
    i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir));
    setPicked({ key, seq: list[i]._seq });
    const box = boxes[key];
    if (box) {
      const top = i * ROW;
      const h = tableHeight(key);
      if (top < box.scrollTop + ROW) box.scrollTop = Math.max(0, top - ROW);
      else if (top + ROW * 2 > box.scrollTop + h) box.scrollTop = top + ROW * 2 - h;
      setScroll({ ...scroll(), [key]: box.scrollTop });
    }
  };
  const window_ = (key) => {
    const l = rowsOf(key);
    const top = scroll()[key] ?? 0;
    const h = rowH();
    const s = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const e = Math.min(l.length, Math.ceil((top + tableHeight(key)) / h) + OVERSCAN);
    return { list: l, start: s, end: e, slice: l.slice(s, e), h };
  };
  const pickedRow = (key) => {
    const p = picked();
    if (!p || p.key !== key) return null;
    return rowsOf(key).find((r) => r._seq === p.seq) ?? null;
  };
  /* Pick on mouse-down, before the list can move under the pointer, and
   * never un-pick by clicking: × and esc close the inspector. */
  const pick = (key, row) => setPicked({ key, seq: row._seq });

  return (
    <div class="space-y-1">
      {/* tabs */}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <For each={tabs()}>
          {(t) => (
            <span class="whitespace-nowrap">
              <button class={t.key === active() ? "text-magenta underline underline-offset-4" : "text-dim hover:text-fg"} onClick={() => switchTo(t)} data-tab={t.key}>
                [{t.key} {() => label(t)}
                {() => (running(t) ? " ●" : "")}]
              </button>
              <button class="text-dim hover:text-red" onClick={() => closeTab(t)} title="close">
                ×
              </button>
            </span>
          )}
        </For>
        <button class="text-green hover:underline" onClick={newTab}>
          [+]
        </button>
      </div>

      {/* editor */}
      <div class="flex flex-wrap items-baseline gap-3">
        <button class="text-dim hover:text-fg" onClick={() => setOpen(!open())}>
          [{open() ? "-" : "+"}] query
        </button>
        <Show when={!open()}>
          <span class="font-mono text-xs text-dim truncate" style={{ "max-width": "40rem" }}>
            {brief(text()).slice(0, 90)}
          </span>
        </Show>
        <button class={busy() ? "text-red hover:underline" : "text-green hover:underline"} onClick={go}>
          {busy() ? "[stop]" : "[run]"}
        </button>
        <Show when={open()}>
          <button class="text-blue hover:underline" onClick={tidy}>
            [format]
          </button>
        </Show>
        <Show when={open()}>
          <span class="text-dim">·</span>
          <For each={Object.entries(examples)}>
            {([k, v]) => (
              <button class="text-blue hover:underline" onClick={() => setText(format(v))} title={`load the ${k} example`}>
                [{k}]
              </button>
            )}
          </For>
        </Show>
        <span class="text-red">{note()}</span>
      </div>

      <Show when={open()}>
        <div class="relative border border-dim" style={{ height: height() }} title="ctrl-enter runs or stops · ctrl-shift-f formats · tab indents">
          <pre ref={mirror} aria-hidden="true" class="absolute inset-0 m-0 overflow-hidden p-2 font-mono text-xs leading-4 whitespace-pre pointer-events-none">
            <For each={lines(text())}>
              {(row) => (
                <div class="min-h-4">
                  <For each={row}>{(t) => <span class={TOKEN_CLASS[t.kind] ?? ""}>{t.text}</span>}</For>
                  {row.length ? null : " "}
                </div>
              )}
            </For>
          </pre>
          <textarea
            ref={area}
            spellcheck={false}
            wrap="off"
            class="absolute inset-0 m-0 h-full w-full resize-none overflow-auto bg-transparent p-2 font-mono text-xs leading-4 whitespace-pre outline-none"
            style={{ color: "transparent", "caret-color": "var(--color-fg, currentColor)" }}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onScroll={sync}
            onKeyDown={onKey}
          />
        </div>
      </Show>

      {/* errors */}
      <Show when={cur()?.errors?.length}>
        <ul class="text-red">
          <For each={cur().errors}>{(e) => <li>{e.line != null ? `line ${e.line}: ${e.message}` : e.message}</li>}</For>
        </ul>
      </Show>

      {/* ops — off for now; the fold is a flip away when the listing matters again */}
      <Show when={SHOW_OPS && cur()?.roots?.length}>
        <div class="space-y-1">
          <button class="text-dim hover:text-fg" onClick={() => setShowOps(!showOps())}>
            [{showOps() ? "-" : "+"}] what the kernel ran
          </button>
          <Show when={showOps()}>
            <For each={cur().plans}>
              {(p) => (
                <table class="w-full text-left text-xs">
                  <thead class="text-yellow">
                    <tr>
                      <th class="pr-4 font-normal">{p.key}</th>
                      <th class="pr-4 font-normal">decode</th>
                      <th class="font-normal">ops</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Show when={p.error}>
                      <tr>
                        <td class="text-red" colspan="3">{p.error?.message}</td>
                      </tr>
                    </Show>
                    <For each={p.fields ?? []}>
                      {(f) => (
                        <tr>
                          <td class="pr-4 text-yellow">{f.name}</td>
                          <td class="pr-4 text-dim">{JSON.stringify(f.decode)}</td>
                          <td class="font-mono">{f.ops}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* tables */}
      <div class="space-y-2" ref={frame}>
        <For each={cur()?.roots ?? []}>
          {(key) => {
            const w = () => window_(key);
            const isPicked = (row) => picked()?.key === key && picked()?.seq === row._seq;
            return (
              <div class="space-y-1">
                <h2 class="comment">
                  {key} · {() => rowsOf(key).length} rows{() => (busy() ? " · running" : "")}
                  {() => (rowsOf(key).length >= (cur()?.keep ?? 500) ? ` · showing the last ${cur()?.keep}` : "")}

                </h2>
                <div ref={(el) => (boxes[key] = el)} class="overflow-auto" style={{ height: `${tableHeight(key)}px` }} data-rows={rowsOf(key).length} onScroll={(e) => setScroll({ ...scroll(), [key]: e.currentTarget.scrollTop })}>
                  <table class="w-full text-left text-xs whitespace-nowrap leading-5">
                    <thead class="text-yellow sticky top-0 bg-bg">
                      <tr>
                        <th class="pr-4 font-normal">time</th>
                        <For each={cols(key)}>{(c) => <th class="pr-4 font-normal">{c.key}</th>}</For>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ height: `${w().start * w().h}px` }} />
                    </tbody>
                    <For each={w().slice}>
                      {(row) => (
                        /* One packet is one tbody — its cells and its window
                         * lines — so a hover or a pick lights the whole thing. */
                        /* The picked packet is inverted — white, black text — the way a terminal marks its selection. */
                        <tbody class={`cursor-pointer ${isPicked(row) ? "bg-fg text-bg" : "hover:bg-mode"}`} onMouseDown={(e) => e.button === 0 && pick(key, row)} onClick={() => pick(key, row)}>
                          <tr style={{ height: `${ROW}px` }} data-seq={row._seq}>
                            <td class={`pr-4 font-mono ${isPicked(row) ? "text-bg" : "text-dim"}`} data-time>{timeOf(row, cur()?.offsetMs)}</td>
                            <For each={cols(key)}>
                              {(c) =>
                                c.window ? (
                                  <td class={`pr-4 font-mono ${isPicked(row) ? "text-bg" : windowCell(c, row).cls}`} data-window={c.key} style={{ "max-width": "40rem", overflow: "hidden", "text-overflow": "ellipsis" }}>
                                    {windowCell(c, row).text}
                                  </td>
                                ) : (
                                  <td class={`pr-4 font-mono ${isPicked(row) ? "text-bg" : classOf(c, row[c.key])}`}>{cell(row[c.key])}</td>
                                )
                              }
                            </For>
                          </tr>
                        </tbody>
                      )}
                    </For>
                    <tbody>
                      <tr style={{ height: `${Math.max(0, w().list.length - w().end) * w().h}px` }} />
                    </tbody>
                  </table>
                </div>

                <Show when={pickedRow(key)}>
                  {(row) => (
                    <div class="overflow-auto font-mono text-xs leading-5 border-t border-fg" style={{ height: `${inspectorHeight()}px` }} data-inspector={row()._seq}>
                      {/* the top edge is the handle: drag it to resize */}
                      <div class="sticky top-0 bg-bg flex items-baseline gap-3 text-dim" style={{ cursor: "row-resize" }} onMouseDown={startResize} data-resize-inspector>
                        <span class="text-yellow">packet</span>
                        <span>{key} · #{row()._seq} · {timeOf(row(), cur()?.offsetMs)}</span>
                        <span class="text-dim">· ↑ ↓ walk · drag this edge to resize · esc closes</span>
                        <button class="ml-auto text-dim hover:text-red" onClick={() => setPicked(null)} onMouseDown={(e) => e.stopPropagation()} title="close (esc)" data-close-inspector>
                          ×
                        </button>
                      </div>
                      <div class="flex flex-wrap gap-x-4 text-dim">
                        <For each={scalarCols(key)}>
                          {(c) => (
                            <span>
                              {c.key} <span class={classOf(c, row()[c.key])}>{cell(row()[c.key])}</span>
                            </span>
                          )}
                        </For>
                      </div>
                      <For each={windowCols(key)}>
                        {(c) => (
                          <div class="mt-1">
                            <div class="text-yellow">
                              {c.key} <span class="text-dim">{row()._raw?.[c.key] ? `${row()._raw[c.key].length / 2} bytes` : "nothing read"}</span>
                            </div>
                            <Show when={isText(c) && row()._raw?.[c.key] && showAs(c, row()) === "text"}>
                              <pre class={`m-0 mb-1 whitespace-pre-wrap break-all ${KIND_CLASS[c.kind] ?? "text-pink"}`}>{textOf(row()._raw[c.key])}</pre>
                            </Show>
                            <For each={xxd(row()._raw?.[c.key] ?? "")}>{(l) => <XxdLine line={l} />}</For>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* meta results */}
      <For each={Object.keys(cur()?.meta ?? {})}>
        {(key) => (
          <div class="space-y-1">
            <h2 class="comment">{key}</h2>
            <pre class="text-xs overflow-x-auto">{JSON.stringify(cur().meta[key], null, 2)}</pre>
          </div>
        )}
      </For>
    </div>
  );
}
