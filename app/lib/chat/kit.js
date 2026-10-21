/* The kit: functionals a `:::ui` body composes a component from.
 *
 * Every builder returns a plain node — `{ k, ...props, kids }` — so
 * what the body built is data, pushed to the page and materialised
 * into DOM there (Widgets.jsx: UiTree). Nothing here draws; nothing
 * here can reach the DOM. The vocabulary is deliberately small and
 * forgiving: a model writes this in one pass, and a value that
 * arrives as a string must still render.
 *
 *   ui.render(
 *     ui.col(
 *       ui.title("peers"),
 *       ui.row(ui.tile("peers", 6), ui.tile("worst srtt", 536, "ms")),
 *       ui.bars(items.map((i) => ({ label: i.peer, value: i.bytes }))),
 *       ui.table(rows, { columns: ["peer", "ms"] }),
 *     ),
 *   );
 *
 * `h(tag, attrs, ...kids)` is the escape hatch for a shape the kit
 * lacks: a few tags, `class` and `title` only. */

const MAX_NODES = 2000;
const MAX_TEXT = 4000;
const TAGS = new Set(["div", "span", "p", "b", "i", "em", "strong", "code", "pre", "small", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "h1", "h2", "h3", "hr", "br"]);
const TONES = new Set(["good", "warn", "bad", "info", "dim"]);

const str = (v) => (v == null ? "" : String(v)).slice(0, MAX_TEXT);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const kids = (list) => list.flat(3).filter((x) => x != null && x !== false).map((x) => (typeof x === "object" && x.k ? x : { k: "text", text: str(x) }));

export const kit = {
  render: null, /* set per object in objects.js */
  h(tag, attrs, ...children) {
    const t = String(tag ?? "div").toLowerCase();
    if (!TAGS.has(t)) return { k: "text", text: str(`<${t}> is not in the kit`) };
    const a = attrs && typeof attrs === "object" && !attrs.k ? attrs : null;
    const rest = a ? children : [attrs, ...children];
    return { k: "h", tag: t, class: a?.class != null ? str(a.class).slice(0, 200) : undefined, title: a?.title != null ? str(a.title).slice(0, 200) : undefined, kids: kids(rest) };
  },
  text: (s, opts = {}) => ({ k: "text", text: str(s), tone: TONES.has(opts.tone) ? opts.tone : undefined }),
  title: (s) => ({ k: "title", text: str(s) }),
  row: (...c) => ({ k: "row", kids: kids(c) }),
  col: (...c) => ({ k: "col", kids: kids(c) }),
  grid: (cols, ...c) => ({ k: "grid", cols: Math.max(1, Math.min(6, Number(cols) || 2)), kids: kids(c) }),
  tile: (label, value, unit) => ({ k: "tile", label: str(label), value: typeof value === "number" ? value : str(value), unit: unit != null ? str(unit) : undefined }),
  badge: (s, tone) => ({ k: "badge", text: str(s), tone: TONES.has(tone) ? tone : "info" }),
  meter: (frac, opts = {}) => ({ k: "meter", frac: Math.max(0, Math.min(1, num(frac) ?? 0)), label: opts.label != null ? str(opts.label) : undefined, warn: num(opts.warn), crit: num(opts.crit) }),
  gauge: (frac, opts = {}) => ({ k: "gauge", frac: Math.max(0, Math.min(1, num(frac) ?? 0)), label: opts.label != null ? str(opts.label) : undefined, text: opts.text != null ? str(opts.text) : undefined }),
  progress: (frac, opts = {}) => ({ k: "meter", frac: Math.max(0, Math.min(1, num(frac) ?? 0)), label: opts.label != null ? str(opts.label) : undefined }),
  spark: (values, opts = {}) => ({ k: "spark", values: (Array.isArray(values) ? values : []).slice(-300).map(num), label: opts.label != null ? str(opts.label) : undefined, unit: opts.unit != null ? str(opts.unit) : undefined }),
  lines: (series, opts = {}) => ({
    k: "lines",
    series: Object.fromEntries(Object.entries(series && typeof series === "object" ? series : {}).slice(0, 12).map(([n, pts]) => [str(n).slice(0, 60), (Array.isArray(pts) ? pts : []).slice(-300).map((p, i) => (p && typeof p === "object" ? { x: num(p.x ?? i), y: num(p.y) } : { x: i, y: num(p) }))])),
    title: opts.title != null ? str(opts.title) : undefined,
    unit: opts.unit != null ? str(opts.unit) : undefined,
  }),
  bars: (items, opts = {}) => ({
    k: "bars",
    bars: (Array.isArray(items) ? items : Object.entries(items ?? {}).map(([label, value]) => ({ label, value }))).slice(0, 40).map((b) => ({ label: str(b?.label ?? b?.name ?? ""), value: num(b?.value) ?? 0 })),
    title: opts.title != null ? str(opts.title) : undefined,
    unit: opts.unit != null ? str(opts.unit) : undefined,
  }),
  table: (rows, opts = {}) => {
    const list = (Array.isArray(rows) ? rows : []).slice(0, 200).map((r) => (r && typeof r === "object" ? r : { value: r }));
    const columns = (Array.isArray(opts.columns) ? opts.columns.map(String) : [...new Set(list.flatMap((r) => Object.keys(r)))]).slice(0, 16);
    return { k: "table", columns, rows: list.map((r) => columns.map((c) => (r[c] == null ? null : typeof r[c] === "object" ? JSON.stringify(r[c]).slice(0, 200) : typeof r[c] === "number" ? r[c] : str(r[c]).slice(0, 200)))), title: opts.title != null ? str(opts.title) : undefined };
  },
  list: (items) => ({ k: "list", items: (Array.isArray(items) ? items : []).slice(0, 100).map((x) => str(x)) }),
  kv: (obj) => ({ k: "kv", pairs: Object.entries(obj && typeof obj === "object" ? obj : {}).slice(0, 60).map(([key, v]) => [str(key).slice(0, 80), typeof v === "number" ? v : str(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 200)]) }),
  code: (s) => ({ k: "code", text: str(s) }),
  hex: (hexString, opts = {}) => ({ k: "hex", hex: str(hexString).replace(/[^0-9a-fA-F]/g, "").slice(0, 8192), title: opts.title != null ? str(opts.title) : undefined }),
  heat: (matrix, opts = {}) => ({
    k: "heat",
    rows: (Array.isArray(matrix) ? matrix : []).slice(0, 64).map((r) => (Array.isArray(r) ? r : []).slice(0, 64).map((v) => num(v) ?? 0)),
    rowLabels: Array.isArray(opts.rows) ? opts.rows.slice(0, 64).map(str) : undefined,
    colLabels: Array.isArray(opts.cols) ? opts.cols.slice(0, 64).map(str) : undefined,
    title: opts.title != null ? str(opts.title) : undefined,
  }),
  sankey: (links, opts = {}) => ({
    k: "sankey",
    links: (Array.isArray(links) ? links : []).slice(0, 60).map((l) => ({ from: str(l?.from ?? l?.source ?? "").slice(0, 60), to: str(l?.to ?? l?.target ?? "").slice(0, 60), value: num(l?.value) ?? 0 })).filter((l) => l.value > 0),
    title: opts.title != null ? str(opts.title) : undefined,
    unit: opts.unit != null ? str(opts.unit) : undefined,
  }),
  echarts: (option, opts = {}) => ({ k: "echarts", option: option && typeof option === "object" ? JSON.parse(JSON.stringify(option, (k, v) => (typeof v === "function" ? undefined : typeof v === "bigint" ? Number(v) : v))) : null, height: Math.max(120, Math.min(900, Number(opts.height) || 300)), title: opts.title != null ? str(opts.title) : undefined }),
  hist: (values, opts = {}) => ({ k: "hist", values: (Array.isArray(values) ? values : []).slice(-5000).map(num).filter((v) => v != null), bins: Math.max(2, Math.min(64, Number(opts.bins) || 16)), title: opts.title != null ? str(opts.title) : undefined, unit: opts.unit != null ? str(opts.unit) : undefined }),
};

/** Count the nodes of a tree; a runaway composition is cut, not sent. */
export function bounded(tree) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return node;
    n++;
    if (n > MAX_NODES) return { k: "text", text: "…", tone: "dim" };
    if (Array.isArray(node.kids)) node.kids = node.kids.map(walk);
    return node;
  };
  return walk(tree);
}
