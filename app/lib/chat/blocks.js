/* The blocks an agent writes: `:::<object>{attrs}` … `:::`.
 *
 *   :::lineChart{live=1000 title="srtt by peer" unit="ms"}
 *   const rows = await query("{ tcp(data: true, limit: 50, ms: 800) { daddr srtt } }");
 *   for (const r of rows.tcp) if (r.srtt) lineChart.push(r.daddr, r.srtt / 1000);
 *   :::
 *
 * The body is JavaScript that runs in the isolate with the named
 * object as a global; what the object collected is drawn in the
 * browser. This module is the shared, pure half: the vocabulary, the
 * parser that both sides run, and the id both sides compute, so the
 * isolate's snapshots and the browser's placeholders meet. */

/* Attributes every block takes: live=<ms>, title, and pin=true (with
 * span=1|2|3) to put it on the dashboard — a grid that overlays the
 * chat, shared by every viewer, fed by the same snapshots. */
export const OBJECTS = {
  lineChart: "lines over time, streaming: push(series, value) each run adds one point per series (the run's pushes average); the chart shows the last `window` seconds (attr, default 60) sliding left; series(name, values) sets a whole line",
  sparkLine: "one small line: push(value)",
  stat: "a headline number: set(label, value, unit?) — several set() calls make several tiles",
  bars: "horizontal bars across categories: set(label, value), largest first",
  table: "a table: rows(list) — an array of plain objects; columns(names) to choose and order them",
  log: "lines of text, newest first: line(text)",
  canvas: "a 2D canvas, width/height in attrs: the usual ctx calls (fillRect, strokeText, beginPath, lineTo, arc, …); drawn when the body returns",
  gauge: "a fraction of a ceiling: set(frac, label?, text?); attrs warn and crit are thresholds on the fraction",
  heatmap: "a grid of values: cell(row, col, value) or add(row, col, value); rows and columns appear in the order first seen",
  histogram: "a distribution: push(value) or values(list); attr bins (default 16)",
  sankey: "flows between named nodes, left to right: flow(from, to, value) accumulates, set(from, to, value) replaces — e.g. local port → peer, or process → peer → port",
  echarts: "any Apache ECharts chart: build an ECharts option (series of type line, bar, pie, scatter, radar, tree, treemap, sunburst, boxplot, candlestick, heatmap, graph, sankey, funnel, gauge, pictorialBar, themeRiver, parallel, lines, custom — with grid/xAxis/yAxis/polar/radar/legend/tooltip/visualMap/dataZoom as needed) and hand it over with echarts.option(o) or return it; the page's dark theme and palette apply; attr height (default 300). Functions cannot cross: a formatter is a template string like \"{b}: {c}\". Use it when none of the other objects is the right shape",
  watch: "a condition the host keeps checking: the body runs every `every` ms (default 5000, at least 2000) and wakes you — a new turn with the value as the message — when it returns a value (not undefined/null/false) or calls watch.fire(payload); watch.stop() ends it; attrs every, title, forever=true to never expire. One wake at a time: fires queue, one per watch, 10 s cooldown",
  done: "an empty block that ends the job: stops every block and watch of this chat; write it when there is nothing left to do",
  ui: "compose a component from the kit and hand it over with ui.render(tree): ui.row(…), ui.col(…), ui.grid(cols, …), ui.title(s), ui.text(s, {tone}), ui.badge(s, tone), ui.tile(label, value, unit), ui.meter(frac, {label, warn, crit}), ui.gauge(frac, {label, text}), ui.spark(values, {label, unit}), ui.lines({name: [values]}, {title, unit}), ui.bars([{label, value}] | {label: value}, {title, unit}), ui.table(rows, {columns, title}), ui.list(items), ui.kv(object), ui.code(text), ui.hex(hexString), ui.heat(matrix, {rows, cols, title}), ui.hist(values, {bins, title}), ui.sankey([{from, to, value}], {title}), ui.echarts(option, {height, title}) for any ECharts chart; ui.h(tag, {class, title}, …kids) for a plain element (div span p b i code pre ul li table tr td th h1-h3); tones: good warn bad info dim",
};

/** A stable id for a block: its object and body. */
export function blockId(name, src) {
  let h = 0;
  const s = `${name}\n${src}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${name}-${(h >>> 0).toString(36)}`;
}

/** `{key=value key="v" key='v'}` → an object; numbers and booleans typed. */
export function parseAttrs(text) {
  const out = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s}]+))/g;
  let m;
  while ((m = re.exec(text ?? ""))) {
    const raw = m[3] ?? m[4] ?? m[5];
    out[m[1]] = m[5] !== undefined ? (raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw) : raw;
  }
  return out;
}

/**
 * Split a reply into markdown and blocks, in order:
 * `[{ t: "md", text } | { t: "block", id, name, attrs, src, line }]`.
 * A block that is not closed yet (streaming) stays markdown.
 */
export function parseBlocks(text) {
  const src = String(text ?? "");
  const out = [];
  /* `:::name` or, as it was first written, `:::js-name`. */
  const re = /^:::(?:js-)?([A-Za-z][\w]*)\s*(\{[^\n]*\})?[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "md", text: src.slice(last, m.index) });
    const name = m[1];
    const body = m[3].replace(/\n$/, "");
    out.push({ t: "block", id: blockId(name, body), name, attrs: parseAttrs(m[2] ?? ""), src: body, known: name in OBJECTS });
    last = m.index + m[0].length;
  }
  if (last < src.length) {
    /* A block still being written — opened, not yet closed — is shown
     * as source while it streams, not as prose. */
    const tail = src.slice(last);
    const open = /^:::(?:js-)?([A-Za-z][\w]*)\s*(\{[^\n]*\})?[ \t]*(\n([\s\S]*))?$/m.exec(tail);
    if (open) {
      if (open.index > 0) out.push({ t: "md", text: tail.slice(0, open.index) });
      out.push({ t: "open", name: open[1], attrs: parseAttrs(open[2] ?? ""), src: open[4] ?? "", known: open[1] in OBJECTS });
    } else out.push({ t: "md", text: tail });
  }
  return out;
}
