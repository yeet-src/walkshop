"use client";

/* The chat: ask, and the agent answers with words and instruments.
 *
 * Runs in the browser. The conversation lives in the isolate and is
 * shared — everyone looking at the page sees the same replies arrive
 * — and reaches here two ways: the history on mount, and frames on
 * the data lane as a reply streams. A reply's `:::<object>` blocks
 * are drawn as widgets; the block's body ran on the host and its
 * snapshot arrives on the same lane, matched by id. */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

import { chatAuth, chatAuto, chatClear, chatHistory, chatInfo, chatLogin, chatPin, chatPins, chatSend, chatStatus, chatStop, chatUnpin } from "./chatActions.js";
import { parseBlocks } from "./chat/blocks.js";
import { tidyJs, tokenizeJs } from "./chat/js.js";
import Md from "./chat/Md.jsx";
import { WIDGETS } from "./chat/Widgets.jsx";
import { openLane } from "./laneClient.js";

/* The block's source, coloured. The globals a body has are lit the
 * way the editor lights a root. */
const JS_CLASS = { comment: "text-dim italic", string: "text-green", number: "text-cyan", keyword: "text-magenta", literal: "text-cyan", global: "text-yellow", prop: "text-blue", type: "text-fg", ident: "text-fg", punct: "text-dim", plain: "text-fg", space: "" };
function Source(props) {
  const globals = () => [props.object, "ctx", "query", "state", "attrs", "h"];
  const attrText = () => {
    const a = Object.entries(props.attrs ?? {});
    return a.length ? `{${a.map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`).join(" ")}}` : "";
  };
  return (
    <pre class="text-xs whitespace-pre overflow-x-auto mt-1 border-l border-rule pl-2">
      <span class="text-dim">:::</span>
      <span class="text-yellow">{props.object}</span>
      <span class="text-dim">{attrText()}</span>
      {"\n"}
      <For each={tokenizeJs(props.streaming ? props.src : tidyJs(props.src), globals())}>{(t) => <span class={JS_CLASS[t.kind] ?? ""}>{t.text}</span>}</For>
      <Show when={props.streaming} fallback={<><span>{"\n"}</span><span class="text-dim">:::</span></>}>
        <span class="text-magenta">▍</span>
      </Show>
    </pre>
  );
}

const EXAMPLES = ["who is this box talking to right now?", "srtt per peer, live", "show me the last HTTP requests", "who is streaming from jellyfin (port 8096: the client is daddr when sport is 8096, saddr otherwise), MB served each", "draw the packet rate on a canvas"];

export default function Chat() {
  /* The transcript is a store reconciled by id, not a signal of fresh
   * arrays: a streamed token changes one message's text in place, so
   * the <For> keeps that message's DOM — and the charts in it — rather
   * than tearing it down and mounting it again for every delta. */
  const [messages, setMessages] = createStore([]); /* { id, role, text, status, error, steps } */
  const replaceMessages = (list) => setMessages(reconcile(list, { key: "id", merge: true }));

  /* The same for a message's blocks: parsing the text again yields new
   * segment objects, so each is a small store keyed by block id (or by
   * place, for prose and the block still being written) that is updated
   * in place while the text grows. */
  const useSegments = (text) => {
    const cache = new Map();
    return createMemo(() => {
      const list = parseBlocks(text() ?? "");
      const seen = new Set();
      const out = list.map((seg, i) => {
        const key = seg.t === "block" ? `b:${seg.id}` : `${seg.t}:${i}`;
        seen.add(key);
        let entry = cache.get(key);
        if (entry) entry[1](reconcile(seg, { merge: true }));
        else cache.set(key, (entry = createStore(seg)));
        return entry[0];
      });
      for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
      return out;
    });
  };
  const EMPTY = {};
  const [ui, setUi] = createSignal({}); /* block id → { data, error, runs, ms, live, expired } */
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [following, setFollowing] = createSignal(true); /* tailing: at the bottom, so new text scrolls into view */
  const [model, setModel] = createSignal("");
  /* The host's account: { ok, login: { code, url } | null }. Unknown until
   * the isolate answers; a reply that failed for want of one flips it. */
  const [auth, setAuth] = createSignal({ ok: true, login: null });
  const logIn = () =>
    chatLogin()
      .then((a) => {
        setAuth(a);
        if (a.login?.url) window.open(a.login.url, "_blank", "noopener");
      })
      .catch(() => {});
  const [agent, setAgent] = createSignal({ busy: false, queued: 0, live: 0, watches: 0, pinned: 0, auto: true }); /* the shared state, pushed by the isolate */
  const [pinStore, setPins] = createStore([]); /* the dashboard: shared, pushed by the isolate, keyed by id */
  const pins = () => pinStore;
  const [dash, setDash] = createSignal(false); /* the overlay, yours */
  /* The corner panel's place: drag its top bar anywhere; remembered
   * per browser. Null means the default corner. */
  const [cornerAt, setCornerAt] = createSignal((() => {
    try {
      const v = JSON.parse(localStorage.getItem("walkshop.corner") ?? "null");
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null;
    } catch {
      return null;
    }
  })());
  const dragCorner = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy));
      setCornerAt({ x, y });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try {
        localStorage.setItem("walkshop.corner", JSON.stringify(cornerAt()));
      } catch {
        /* no storage */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const cornerStyle = () => {
    const at = cornerAt();
    const base = { "max-height": "45vh", background: "rgba(0,0,0,0.55)", "backdrop-filter": "blur(6px)", "overscroll-behavior": "contain" };
    return at ? { ...base, left: `${at.x}px`, top: `${at.y}px` } : { ...base, right: "1rem", bottom: "3.25rem" };
  };

  /* The spinner: what the agent is doing right now and for how long.
   * The phase is the newest reply's status while it is in progress —
   * thinking, looking (a tool), streaming — else "working" when the
   * shared state says busy. Elapsed restarts when the phase changes. */
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const LABEL = { thinking: "thinking", tool: "looking", streaming: "writing", working: "working" };
  const phase = () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const st = last?.status;
    if (st === "thinking" || st === "tool" || st === "streaming") return st;
    return agent().busy ? "working" : null;
  };
  const [phaseAt, setPhaseAt] = createSignal(0);
  const [tick, setTick] = createSignal(0);
  let lastPhase = null;
  createEffect(() => {
    const p = phase();
    if (p !== lastPhase) {
      lastPhase = p;
      setPhaseAt(Date.now());
    }
  });
  onMount(() => {
    const spin = setInterval(() => {
      if (phase()) setTick((t) => t + 1);
    }, 100);
    onCleanup(() => clearInterval(spin));
  });
  const elapsed = () => {
    tick(); /* re-read every spinner frame, so the clock moves */
    return ((Date.now() - phaseAt()) / 1000).toFixed(1);
  };
  let closeLane = () => {};
  let bottom;

  /* Tail like a terminal: while you are at the bottom the page follows
   * the reply; scroll up to read and it stops, until you come back or
   * press the button. */
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  const follow = () => {
    if (following()) requestAnimationFrame(toBottom);
  };

  const upsert = (m) => {
    const list = unwrap(messages);
    const i = list.findIndex((x) => x.id === m.id);
    const next = i < 0 ? [...list, m] : list.map((x, j) => (j === i ? { ...x, ...m } : x));
    replaceMessages(next);
  };

  const onFrame = (f) => {
    if (f.op === "walkshop-chat") {
      if (f.cleared) {
        replaceMessages([]);
        setUi({});
        return;
      }
      const cur = unwrap(messages).find((x) => x.id === f.id) ?? { id: f.id, role: f.role, text: "", steps: [] };
      if (f.status && typeof f.status === "object" && !f.id) {
        setAgent(f.status);
        setBusy(Boolean(f.status.busy));
        return;
      }
      if (Array.isArray(f.pins) && !f.id) {
        takePins(f.pins);
        return;
      }
      if (f.login && !f.id) {
        if (f.login.ok) setAuth({ ok: true, login: null });
        else if (f.login.pending) setAuth({ ok: false, login: { code: f.login.code, url: f.login.url } });
        else setAuth({ ok: false, login: null, error: f.login.error });
        return;
      }
      const m = { ...cur, role: f.role ?? cur.role, status: f.status ?? cur.status, at: f.at ?? cur.at, kind: f.kind ?? cur.kind };
      if (f.text != null) m.text = f.text;
      if (f.delta) m.text = (m.text ?? "") + f.delta;
      if (f.reset) m.text = "";
      if (f.step) m.steps = [...(cur.steps ?? []), f.step];
      if (f.stepDone) {
        const steps = (m.steps ?? cur.steps ?? []).slice();
        if (steps[f.stepDone.index]) steps[f.stepDone.index] = { ...steps[f.stepDone.index], ms: f.stepDone.ms, error: f.stepDone.error };
        m.steps = steps;
      }
      if (f.steps) m.steps = f.steps;
      if (f.done) {
        m.status = f.error ? "error" : "done";
        m.error = f.error ?? null;
        if (f.error && /WhoAmI/.test(f.error)) chatAuth().then(setAuth).catch(() => {});
      }
      upsert(m);
      if (f.done) setBusy(false);
      follow();
      const corner = document.querySelector("[data-dash-latest]");
      if (corner) corner.scrollTop = corner.scrollHeight;
    } else if (f.op === "walkshop-ui" && f.block) {
      setUi((u) => ({ ...u, [f.block]: { ...(u[f.block] ?? {}), ...f } }));
      follow();
    }
  };

  /* A pin carries the block's last snapshot, so a page that arrives
   * late can draw it before the next frame. */
  const takePins = (list) => {
    setPins(reconcile(list, { key: "id", merge: true }));
    setUi((u) => {
      const n = { ...u };
      for (const p of list) if (p.last && !n[p.id]?.data) n[p.id] = { ...(n[p.id] ?? {}), ...p.last, name: p.name, attrs: p.attrs };
      return n;
    });
  };

  onMount(async () => {
    chatInfo().then((i) => setModel(i.model)).catch(() => {});
    /* The account can go away under an open page (a logout, a daemon
     * restart), so look again now and then, not only at mount. */
    const checkAuth = () => chatAuth().then(setAuth).catch(() => {});
    checkAuth();
    const authTimer = setInterval(checkAuth, 20_000);
    onCleanup(() => clearInterval(authTimer));
    chatPins().then(takePins).catch(() => {});
    chatStatus().then((st) => { setAgent(st); setBusy(Boolean(st.busy)); }).catch(() => {});
    try {
      replaceMessages(await chatHistory());
    } catch {
      /* the lane will fill it in */
    }
    closeLane = openLane(onFrame);
  });
  onCleanup(() => closeLane());

  const ask = async (text) => {
    const q = String(text ?? draft()).trim();
    if (!q) return;
    setDraft("");
    setBusy(true);
    setFollowing(true);
    follow();
    try {
      await chatSend(q);
    } catch (e) {
      upsert({ id: `local-${Date.now()}`, role: "assistant", text: "", status: "error", error: String(e?.message ?? e) });
      setBusy(false);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ask();
    }
  };
  onMount(() => {
    const esc = (e) => {
      if (e.key === "Escape" && dash()) setDash(false);
    };
    window.addEventListener("keydown", esc);
    onCleanup(() => window.removeEventListener("keydown", esc));
  });
  /* With the overlay up the page itself must not scroll: a wheel at
   * the end of the grid, or over a chart, would otherwise move the
   * chat underneath. */
  createEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.overflow = dash() ? "hidden" : "";
  });
  onCleanup(() => {
    if (typeof document !== "undefined") document.documentElement.style.overflow = "";
  });

  /* The island is a column as tall as the rest of the page: the
   * transcript grows, the prompt sits at the bottom — in the flow,
   * sticky, so it is at the foot of a short transcript and stays put
   * at the viewport's edge while a long one scrolls. */
  let root;
  const [minH, setMinH] = createSignal("calc(100dvh - 4rem)");
  const fit = () => {
    if (!root) return;
    const top = root.getBoundingClientRect().top + window.scrollY;
    setMinH(`calc(100dvh - ${Math.round(top)}px - 8px)`);
  };
  onMount(() => {
    /* The island mounts before the page around it has settled — the
     * stylesheet, the nav, the fonts — so its top moves after this
     * runs. Measure now, again on the next frames and on load, and
     * whenever the body's size changes, not only on a window resize. */
    fit();
    requestAnimationFrame(() => {
      fit();
      requestAnimationFrame(fit);
    });
    window.addEventListener("load", fit);
    window.addEventListener("resize", fit);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(document.body);
    const onScroll = () => setFollowing(atBottom());
    window.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => {
      window.removeEventListener("load", fit);
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    });
  });

  return (
    <div class="flex flex-col gap-3" ref={root} style={{ "min-height": minH() }}>
      <div class="flex flex-wrap items-baseline gap-3 text-xs">
        <span class="text-dim">try</span>
        <For each={EXAMPLES}>
          {(ex) => (
            <button class="text-blue hover:underline" onClick={() => ask(ex)}>
              [{ex}]
            </button>
          )}
        </For>
        <button class="ml-auto text-dim hover:text-fg" onClick={() => setDash(!dash())} data-dash-toggle>
          [dashboard{() => (pins().length ? ` ${pins().length}` : "")}]
        </button>
        <button class={agent().auto === false ? "text-yellow hover:text-fg" : "text-dim hover:text-fg"} title="whether a watch may wake the agent on its own" onClick={() => chatAuto(agent().auto === false).then(setAgent).catch(() => {})} data-auto-toggle>
          [auto {() => (agent().auto === false ? "off" : "on")}]
        </button>
        <button class="text-dim hover:text-red" onClick={() => chatClear().catch(() => {})}>
          [clear]
        </button>
      </div>

      <div class="space-y-4 flex-1">
        <For each={messages}>
          {(m) => (
            <div class="space-y-2" data-message={m.id} data-role={m.role} data-status={m.status}>
              <Show when={m.role === "user"}>
                <Show when={m.kind === "wake"} fallback={<div class="text-magenta">» {m.text}</div>}>
                  <div class="text-cyan text-xs whitespace-pre-wrap">⚡ {m.text}</div>
                </Show>
              </Show>
              <Show when={m.role === "assistant"}>
                <Show when={m.steps?.length}>
                  {(() => {
                    /* What the agent ran before answering: open while it
                     * is still looking, folded to one line once the reply
                     * is done, a click away either way. */
                    const [manual, setManual] = createSignal(null);
                    const working = () => m.status === "thinking" || m.status === "tool" || m.status === "streaming";
                    const open = () => manual() ?? working();
                    const tools = () => (m.steps ?? []).filter((s) => s.kind === "tool");
                    return (
                      <div class="text-xs" data-steps={open() ? "open" : "folded"}>
                        <button class="text-dim hover:text-fg" onClick={() => setManual(!open())}>
                          [{open() ? "-" : "+"}] ran {tools().length} snippet{tools().length === 1 ? "" : "s"}
                          {() => (working() ? "…" : ` · ${tools().reduce((a, s) => a + (s.ms ?? 0), 0)} ms`)}
                        </button>
                        <Show when={open()}>
                          <div class="space-y-1 mt-1 border-l border-rule pl-2">
                            <For each={m.steps}>
                              {(s) =>
                                s.kind === "tool" ? (
                                  <div>
                                    <pre class="whitespace-pre overflow-x-auto">
                                      <For each={tokenizeJs(tidyJs(String(s.args?.code ?? s.args?.query ?? "")), ["query", "state"])}>{(t) => <span class={JS_CLASS[t.kind] ?? ""}>{t.text}</span>}</For>
                                    </pre>
                                    <div class={s.error ? "text-red" : "text-dim"}>{s.error ? `→ ${s.error}` : s.ms != null ? `→ ${s.ms} ms` : "→ running…"}</div>
                                  </div>
                                ) : (
                                  <div class="text-dim">{s.text}</div>
                                )
                              }
                            </For>
                          </div>
                        </Show>
                      </div>
                    );
                  })()}
                </Show>
                <Show when={m.status === "thinking" || m.status === "tool"}>
                  <div class="text-dim text-xs">{m.status === "tool" ? "looking…" : "thinking…"}</div>
                </Show>
                <For each={useSegments(() => m.text)()}>
                  {(seg) =>
                    seg.t === "md" ? (
                      <Md text={seg.text} />
                    ) : seg.t === "open" ? (
                      /* still being written: the source, growing */
                      <div class="border-l border-dim pl-3" data-open-block={seg.name}>
                        <Source object={seg.name} attrs={seg.attrs} src={seg.src} streaming />
                      </div>
                    ) : (
                      <div class="border-l border-dim pl-3 space-y-1" data-block={seg.id} data-object={seg.name}>
                        {(() => {
                          const Widget = WIDGETS[seg.name];
                          /* A memo on this block's own entry: another block's
                           * frame replaces the map but not this entry, so the
                           * widget below does not redraw for it. */
                          const u = createMemo(() => ui()[seg.id] ?? EMPTY);
                          /* The source shows while the block is being written and
                           * until it has drawn; then the widget takes its place and
                           * the source is a fold away. */
                          const [showSrc, setShowSrc] = createSignal(false);
                          const drawn = () => Boolean(u().data);
                          const sourceVisible = () => showSrc() || (!drawn() && !u().error);
                          return (
                            <>
                              <Show when={!Widget}>
                                <div class="text-red text-xs">no such object: {seg.name}</div>
                              </Show>
                              <Show when={Widget}>
                                <Show when={u().data}>
                                  <Widget data={u().data} attrs={seg.attrs} />
                                </Show>
                              </Show>
                              <Show when={u().error}>
                                <div class="text-red text-xs">{u().error}</div>
                              </Show>
                              <div class="text-dim text-xs flex gap-3">
                                <span>
                                  {seg.name}
                                  {u().live ? ` · ${seg.name === "watch" ? "checks" : "live"} every ${seg.attrs.live ?? seg.attrs.every ?? (seg.name === "watch" ? 5000 : "?")} ms · ${u().runs ?? 0} runs` : u().runs ? ` · ran in ${u().ms} ms` : ""}
                                  {u().expired ? " · expired" : ""}
                                </span>
                                <Show when={u().live}>
                                  <button class="hover:text-red" onClick={() => chatStop(seg.id).catch(() => {})}>
                                    [stop]
                                  </button>
                                </Show>
                                <Show when={Widget && seg.name !== "watch" && seg.name !== "done"}>
                                  <button class="hover:text-fg" onClick={() => (pins().some((p) => p.id === seg.id) ? chatUnpin(seg.id) : chatPin(seg.id, seg.attrs.span)).catch(() => {})} data-pin={seg.id}>
                                    {() => (pins().some((p) => p.id === seg.id) ? "[unpin]" : "[pin]")}
                                  </button>
                                </Show>
                                <Show when={drawn() || u().error}>
                                  <button class="hover:text-fg" onClick={() => setShowSrc(!showSrc())}>
                                    [{showSrc() ? "-" : "+"}] source
                                  </button>
                                </Show>
                              </div>
                              <Show when={sourceVisible()}>
                                <Source object={seg.name} attrs={seg.attrs} src={seg.src} />
                              </Show>
                            </>
                          );
                        })()}
                      </div>
                    )
                  }
                </For>
                <Show when={m.error}>
                  <div class="text-red text-xs">{m.error}</div>
                </Show>
              </Show>
            </div>
          )}
        </For>
        <div ref={bottom} />
      </div>

      {/* the dashboard: the pinned blocks on a responsive grid, over the chat */}
      <Show when={dash()}>
        <div class="fixed inset-x-0 top-0 z-40 overflow-auto p-4 bg-bg" style={{ bottom: "2.75rem", "overscroll-behavior": "contain" }} data-dashboard>
          <div class="flex items-baseline gap-3 mb-3 text-xs">
            <span class="text-yellow">dashboard</span>
            <span class="text-dim">{() => `${pins().length} pinned · shared by every viewer · esc closes`}</span>
            <button class="ml-auto text-dim hover:text-fg" onClick={() => setDash(false)} data-dash-close>
              [close]
            </button>
          </div>
          {/* the conversation, in the corner: see-through, the last few
              exchanges as prose, a block as a chip, streaming as it comes */}
          <div class="fixed z-50 w-[28rem] max-w-[calc(100vw-2rem)] sm:max-w-[45vw] overflow-auto border border-rule p-2 text-xs space-y-2" style={cornerStyle()} data-dash-latest ref={(el) => setTimeout(() => (el.scrollTop = el.scrollHeight), 0)}>
            {/* the handle: drag it to move the panel; double-click sends it home */}
            <div class="sticky -top-2 -mx-2 -mt-2 px-2 py-1 text-dim select-none flex items-baseline gap-2" style={{ cursor: "move", background: "rgba(0,0,0,0.7)" }} onMouseDown={dragCorner} onDblClick={() => { setCornerAt(null); try { localStorage.removeItem("walkshop.corner"); } catch {} }} data-corner-handle>
              <span>⋮⋮ chat</span>
              <span class="ml-auto">drag · double-click to reset</span>
            </div>
            <Show when={!messages.length}>
              <div class="text-dim">say what to put on the board</div>
            </Show>
            <For each={messages.slice(-6)}>
              {(m) => (
                <div class={m.role === "user" ? (m.kind === "wake" ? "text-cyan" : "text-magenta") : "text-fg"}>
                  <Show when={m.role === "user"}>
                    {m.kind === "wake" ? "⚡ " : "» "}
                    {m.text}
                  </Show>
                  <For each={m.role === "user" ? [] : useSegments(() => m.text)()}>
                    {(seg) =>
                      seg.t === "md" ? (
                        <Md text={seg.text} />
                      ) : (
                        <span class="text-dim border border-rule px-1 mx-0.5">
                          {seg.name}
                          {seg.attrs?.title ? ` · ${seg.attrs.title}` : ""}
                          {seg.attrs?.pin ? " · pinned" : ""}
                        </span>
                      )
                    }
                  </For>
                  <Show when={m.status === "thinking" || m.status === "tool" || m.status === "streaming"}>
                    <span class="text-green"> {FRAMES[tick() % FRAMES.length]}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show when={pins().length} fallback={<div class="text-dim text-xs">nothing pinned: [pin] a block in the chat, ask for a dashboard, or tell the agent what to put here</div>}>
            <div class="grid gap-3" style={{ "grid-template-columns": "repeat(auto-fit, minmax(min(340px, 100%), 1fr))" }} data-grid>
              <For each={pins()}>
                {(p) => {
                  const Widget = WIDGETS[p.name];
                  const u = createMemo(() => ui()[p.id] ?? EMPTY);
                  return (
                    <div class="border border-rule p-2 min-w-0" style={{ "grid-column": `span ${Math.min(3, p.span || 1)}` }} data-tile={p.id}>
                      <div class="flex items-baseline gap-2 text-xs mb-1">
                        <span class="text-yellow">{p.attrs?.title ?? p.name}</span>
                        <span class="text-dim">{() => (u().live ? "live" : u().expired ? "expired" : u().runs ? "stopped" : "")}</span>
                        <span class="ml-auto flex gap-1 text-dim">
                          <For each={[1, 2, 3]}>
                            {(n) => (
                              <button class={p.span === n ? "text-fg" : "hover:text-fg"} onClick={() => chatPin(p.id, n).catch(() => {})}>
                                [{n}]
                              </button>
                            )}
                          </For>
                          <button class="hover:text-red" onClick={() => chatUnpin(p.id).catch(() => {})}>
                            [×]
                          </button>
                        </span>
                      </div>
                      <Show when={Widget && u().data} fallback={<div class="text-dim text-xs">{u().error ?? "waiting for its first run…"}</div>}>
                        <Widget data={u().data} attrs={{ ...p.attrs, title: undefined }} />
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* the prompt: stuck to the bottom, a chevron and a cursor, nothing else */}
      <div class="sticky bottom-0 mt-auto bg-bg border-t border-rule relative z-50" data-prompt-bar>
        <Show when={!following() && messages.length}>
          <button class="absolute right-0 -top-7 text-dim hover:text-fg text-xs" onClick={() => { setFollowing(true); toBottom(); }}>
            [↓ newest]
          </button>
        </Show>
        <div class="py-2 flex items-baseline gap-2 font-mono">
          <Show when={phase()} fallback={<span class="text-magenta">»</span>}>
            <span class="text-green whitespace-nowrap" data-spinner={phase()}>
              {() => FRAMES[tick() % FRAMES.length]} {() => LABEL[phase()] ?? phase()} {() => elapsed()}s
            </span>
          </Show>
          <input
            ref={(el) => setTimeout(() => el.focus(), 0)}
            class="flex-1 bg-transparent text-fg outline-none border-0 p-0 font-mono"
            style={{ "caret-color": "var(--color-magenta)" }}
            placeholder={busy() ? "" : "ask about this box's traffic"}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKey}
            autocomplete="off"
            spellcheck={false}
            data-chat-input
          />
          {/* the state, stuck to the bottom with the prompt */}
          <span class="text-xs whitespace-nowrap min-w-0 overflow-hidden text-ellipsis" data-agent-status={agent().busy ? "working" : "idle"}>
            <span class={agent().busy ? "text-yellow" : "text-dim"}>{agent().busy ? "● working" : "○ idle"}</span>
            <span class="text-dim">
              {() => (agent().live ? ` · ${agent().live} live` : "")}
              {() => (agent().watches ? ` · ${agent().watches} watch${agent().watches === 1 ? "" : "es"}` : "")}
              {() => (agent().queued ? ` · ${agent().queued} ${agent().auto === false ? "held" : "queued"}` : "")}
              {() => (agent().auto === false ? " · auto off" : "")}
              {() => (agent().pinned ? ` · ${agent().pinned} pinned` : "")}
            </span>
            <span class="text-dim hidden sm:inline">{() => (model() ? ` · ${model()}` : "")}</span>
            <Show when={!auth().ok}>
              <span class="text-yellow" data-auth="out">
                {" · not logged in · "}
                <Show when={auth().login?.url} fallback={<button class="underline hover:text-fg" onClick={logIn} data-login>[log in]</button>}>
                  <a class="underline hover:text-fg" href={auth().login.url} target="_blank" rel="noopener" data-login>
                    log in{auth().login.code ? ` (code ${auth().login.code})` : ""}
                  </a>
                  <span class="text-dim"> · waiting…</span>
                </Show>
              </span>
            </Show>
          </span>
        </div>
      </div>
    </div>
  );
}
