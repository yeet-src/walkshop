/* The objects a block draws with: collectors. A body calls methods on
 * one of these; what it collected is the snapshot the browser draws.
 * Every method is forgiving — it is called by code a model wrote in one
 * pass — and keeps a bounded amount. Pure. */

import { bounded, kit } from "./kit.js";

const WINDOW = 300; /* points per series */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function make(name, attrs = {}) {
  switch (name) {
    case "lineChart": {
      /* The object lives for the block, so a live chart keeps its
       * history: each run adds one point per series — the mean of what
       * the body pushed for it in that run, stamped at the run — and a
       * series() call sets a whole line at once. */
      const series = new Map();
      const pending = new Map();
      return {
        api: {
          push(s, y, x) {
            const key = String(s ?? "value");
            const v = num(y);
            if (v == null) return;
            if (x != null) {
              if (!series.has(key)) series.set(key, []);
              series.get(key).push({ x: num(x), y: v });
              return;
            }
            if (!pending.has(key)) pending.set(key, []);
            pending.get(key).push(v);
          },
          series(s, values) {
            const key = String(s ?? "value");
            series.set(key, (Array.isArray(values) ? values : []).slice(-WINDOW).map((v, i) => (v && typeof v === "object" ? { x: num(v.x ?? i), y: num(v.y) } : { x: i, y: num(v) })));
          },
        },
        flush() {
          const now = Date.now();
          for (const [key, vals] of pending) {
            if (!series.has(key)) series.set(key, []);
            const l = series.get(key);
            l.push({ x: now, y: vals.reduce((a, b) => a + b, 0) / vals.length });
            if (l.length > WINDOW) l.splice(0, l.length - WINDOW);
          }
          pending.clear();
          for (const [, l] of series) if (l.length > WINDOW) l.splice(0, l.length - WINDOW);
        },
        snapshot: () => ({ series: Object.fromEntries([...series.entries()].slice(0, 12)) }),
      };
    }
    case "sankey": {
      /* Flows between named nodes, accumulated for the block's life. */
      const links = new Map();
      return {
        api: {
          flow(from, to, value) {
            const k = `${String(from ?? "")}\u0000${String(to ?? "")}`;
            links.set(k, (links.get(k) ?? 0) + (num(value) ?? 0));
          },
          set(from, to, value) {
            links.set(`${String(from ?? "")}\u0000${String(to ?? "")}`, num(value) ?? 0);
          },
        },
        snapshot: () => ({
          links: [...links.entries()]
            .map(([k, value]) => {
              const [from, to] = k.split("\u0000");
              return { from, to, value };
            })
            .filter((l) => l.value > 0)
            .sort((a, b) => b.value - a.value)
            .slice(0, 60),
        }),
      };
    }
    case "sparkLine": {
      let values = [];
      return {
        api: {
          push(v) {
            values.push(num(v));
            if (values.length > WINDOW) values.splice(0, values.length - WINDOW);
          },
          values(list) {
            values = (Array.isArray(list) ? list : []).slice(-WINDOW).map(num);
          },
        },
        snapshot: () => ({ values }),
      };
    }
    case "stat": {
      const tiles = new Map();
      return {
        api: {
          set(label, value, unit) {
            tiles.set(String(label ?? ""), { value: typeof value === "number" ? value : String(value ?? ""), unit: unit != null ? String(unit) : null });
          },
        },
        snapshot: () => ({ tiles: [...tiles.entries()].slice(0, 12).map(([label, t]) => ({ label, ...t })) }),
      };
    }
    case "bars": {
      const bars = new Map();
      return {
        api: {
          set(label, value) {
            bars.set(String(label ?? ""), num(value) ?? 0);
          },
          add(label, value) {
            const k = String(label ?? "");
            bars.set(k, (bars.get(k) ?? 0) + (num(value) ?? 0));
          },
        },
        snapshot: () => ({ bars: [...bars.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 24) }),
      };
    }
    case "table": {
      let rows = [];
      let columns = null;
      return {
        api: {
          rows(list) {
            rows = (Array.isArray(list) ? list : []).slice(0, 200).map((r) => (r && typeof r === "object" ? r : { value: r }));
          },
          columns(names) {
            columns = Array.isArray(names) ? names.map(String) : null;
          },
        },
        snapshot: () => {
          const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 16);
          return { columns: cols, rows: rows.map((r) => cols.map((c) => (r[c] == null ? null : typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c]))) };
        },
      };
    }
    case "log": {
      const lines = [];
      return {
        api: {
          line(text) {
            lines.unshift(String(text ?? ""));
            if (lines.length > 200) lines.length = 200;
          },
        },
        snapshot: () => ({ lines }),
      };
    }
    case "canvas": {
      /* A virtual 2D context: calls are recorded and replayed in the
       * browser. Write-only — nothing here can answer measureText. */
      const METHODS = new Set(["arc", "arcTo", "beginPath", "bezierCurveTo", "clearRect", "clip", "closePath", "ellipse", "fill", "fillRect", "fillText", "lineTo", "moveTo", "quadraticCurveTo", "rect", "resetTransform", "restore", "rotate", "roundRect", "save", "scale", "setLineDash", "setTransform", "stroke", "strokeRect", "strokeText", "transform", "translate"]);
      const PROPS = new Set(["fillStyle", "font", "globalAlpha", "lineCap", "lineDashOffset", "lineJoin", "lineWidth", "strokeStyle", "textAlign", "textBaseline"]);
      let ops = [];
      const width = Number(attrs.width) || 640;
      const height = Number(attrs.height) || 160;
      const ctx = new Proxy(
        { width, height },
        {
          get(t, p) {
            if (p in t) return t[p];
            if (typeof p !== "string") return undefined;
            if (METHODS.has(p)) return (...args) => {
              if (ops.length < 20000) ops.push(["c", p, args.map((a) => (typeof a === "number" || typeof a === "string" || typeof a === "boolean" ? a : Array.isArray(a) ? a : String(a)))]);
            };
            return undefined;
          },
          set(t, p, v) {
            if (PROPS.has(p)) ops.push(["s", p, typeof v === "number" ? v : String(v)]);
            return true;
          },
        },
      );
      return { api: ctx, snapshot: () => ({ width, height, ops }), reset: () => (ops = []) };
    }
    case "gauge": {
      let g = { frac: 0, label: null, text: null };
      return {
        api: {
          set(frac, label, text) {
            g = { frac: Math.max(0, Math.min(1, num(frac) ?? 0)), label: label != null ? String(label) : null, text: text != null ? String(text) : null };
          },
        },
        snapshot: () => ({ ...g, warn: num(attrs.warn), crit: num(attrs.crit) }),
      };
    }
    case "heatmap": {
      const cells = new Map(); /* "r\tc" → value */
      const rows = [];
      const cols = [];
      return {
        api: {
          cell(r, c, v) {
            const R = String(r ?? "");
            const C = String(c ?? "");
            if (!rows.includes(R) && rows.length < 64) rows.push(R);
            if (!cols.includes(C) && cols.length < 64) cols.push(C);
            cells.set(`${R}\t${C}`, num(v) ?? 0);
          },
          add(r, c, v) {
            const R = String(r ?? "");
            const C = String(c ?? "");
            if (!rows.includes(R) && rows.length < 64) rows.push(R);
            if (!cols.includes(C) && cols.length < 64) cols.push(C);
            cells.set(`${R}\t${C}`, (cells.get(`${R}\t${C}`) ?? 0) + (num(v) ?? 0));
          },
        },
        snapshot: () => ({ rows: rows.map((R) => cols.map((C) => cells.get(`${R}\t${C}`) ?? 0)), rowLabels: rows, colLabels: cols }),
      };
    }
    case "histogram": {
      let values = [];
      return {
        api: {
          push(v) {
            const n = num(v);
            if (n != null) values.push(n);
            if (values.length > 5000) values.splice(0, values.length - 5000);
          },
          values(list) {
            values = (Array.isArray(list) ? list : []).map(num).filter((v) => v != null).slice(-5000);
          },
        },
        snapshot: () => ({ values, bins: Math.max(2, Math.min(64, Number(attrs.bins) || 16)) }),
      };
    }
    case "ui": {
      /* The kit, plus render(tree): the body composes and hands over a
       * tree; the page materialises it. A body that returns a tree
       * without calling render() gets the same treatment (run.js). */
      let tree = null;
      const api = { ...kit, render(t) {
        tree = t && typeof t === "object" && t.k ? t : kit.col(t);
      } };
      return { api, snapshot: () => ({ tree: tree ? bounded(tree) : null }), reset: () => (tree = null), take: (returned) => { if (!tree && returned && typeof returned === "object" && returned.k) tree = returned; } };
    }
    case "watch": {
      /* A predicate the host keeps evaluating. The body fires by
       * calling watch.fire(payload) or by returning a value that is not
       * undefined, null or false; the payload wakes the agent (run.js →
       * agent.js). watch.stop() ends it after this run. */
      let fired = null;
      let stopped = false;
      let fires = 0;
      let last = null;
      return {
        api: {
          fire(payload) {
            fired = payload === undefined ? true : payload;
          },
          stop() {
            stopped = true;
          },
          get fires() {
            return fires;
          },
        },
        reset: () => (fired = null),
        take: (returned) => {
          if (fired === null && returned !== undefined && returned !== null && returned !== false) fired = returned;
        },
        /* what run.js asks after a run */
        fired: () => fired,
        stopped: () => stopped,
        noteFire: (payload) => {
          fires++;
          last = { at: Date.now(), payload };
        },
        snapshot: () => ({ fires, last, stopped }),
      };
    }
    case "echarts": {
      /* The whole library: the body builds an ECharts option and hands
       * it over with echarts.option(o) or by returning it. Functions
       * cannot cross to the page, so a formatter is a template string
       * ("{b}: {c}"); anything that is not data is dropped. */
      let option = null;
      const clean = (v, depth = 0) => {
        if (depth > 12 || v == null) return v ?? null;
        if (typeof v === "function" || typeof v === "symbol") return undefined;
        if (typeof v === "bigint") return Number(v);
        if (Array.isArray(v)) return v.slice(0, 20000).map((x) => clean(x, depth + 1));
        if (typeof v === "object") {
          const out = {};
          for (const [k, x] of Object.entries(v)) {
            const c = clean(x, depth + 1);
            if (c !== undefined) out[k] = c;
          }
          return out;
        }
        return v;
      };
      return {
        api: {
          option(o) {
            option = clean(o);
          },
        },
        reset: () => (option = null),
        take: (returned) => {
          if (!option && returned && typeof returned === "object" && !Array.isArray(returned)) option = clean(returned);
        },
        snapshot: () => ({ option }),
      };
    }
    case "done": {
      /* Nothing to collect: running it stops every block of the chat. */
      return { api: {}, snapshot: () => ({ done: true }) };
    }
    default:
      return null;
  }
}
