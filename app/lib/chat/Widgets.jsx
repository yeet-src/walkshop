/* What a block's snapshot looks like on the page. Browser side: these
 * draw, and only draw — the numbers were collected in the isolate. One
 * palette, no legend chrome: the series name sits at the line's end. */
import { createEffect, For, onCleanup, onMount, Show } from "solid-js";

import { fmt, mount, PALETTE } from "./echarts.js";
import { Dynamic } from "solid-js/web";

import { xxd } from "../hex.js";


/* A chart widget is one ECharts instance per widget, mounted once,
 * fed by setOption on every snapshot — merged, so lines and bars
 * animate from their last frame. */
function useChart(height, build) {
  let host;
  let mounted = null;
  let gone = false;
  let latest = null; /* the option to apply once the chart exists */
  const apply = () => {
    if (!mounted || !latest) return;
    mounted.setHeight(height());
    mounted.chart.setOption(latest, { notMerge: false, lazyUpdate: true });
  };
  onMount(async () => {
    const m = await mount(host, height());
    if (gone) return m.dispose();
    mounted = m;
    apply();
  });
  onCleanup(() => {
    gone = true;
    mounted?.dispose();
  });
  createEffect(() => {
    latest = build();
    apply();
  });
  return { ref: (el) => (host = el), get chart() { return mounted?.chart; } };
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

/* Lines over time: one series per name, a sliding window of the last
 * `window` seconds (attr, default 60) ending now, moved four times a
 * second so the lines slide between runs and the newest point stays
 * at the right edge. Index data (a series() of plain values) has no
 * clock and gets a value axis instead. */
export function LineChart(props) {
  const unit = () => props.attrs?.unit ?? "";
  const series = () => props.data?.series ?? {};
  const names = () => Object.keys(series()).slice(0, 12);
  const timed = () => names().some((n) => (series()[n] ?? []).some((p) => p.x > 1e11));
  const windowMs = () => Math.max(10, Number(props.attrs?.window) || 60) * 1000;
  const c = useChart(
    () => 260,
    () => {
      const now = Date.now();
      return {
        animationDurationUpdate: 350,
        grid: { left: 56, right: 72, top: 16, bottom: names().length ? 44 : 28 },
        tooltip: { trigger: "axis", axisPointer: { type: "cross" }, valueFormatter: (v) => fmt(v, unit()) },
        legend: { show: names().length > 0, bottom: 0, icon: "rect", itemWidth: 10, itemHeight: 10, type: "scroll" },
        xAxis: timed() ? { type: "time", min: now - windowMs(), max: now, axisLabel: { formatter: (v) => clock(v), hideOverlap: true } } : { type: "value", min: "dataMin", max: "dataMax" },
        yAxis: { type: "value", scale: true, axisLabel: { formatter: (v) => fmt(v, unit()) } },
        series: names().map((n, i) => ({
          name: n,
          type: "line",
          showSymbol: false,
          smooth: 0.15,
          connectNulls: false,
          emphasis: { focus: "series" },
          lineStyle: { width: 2, color: PALETTE[i % PALETTE.length] },
          itemStyle: { color: PALETTE[i % PALETTE.length] },
          endLabel: { show: true, formatter: (p) => fmt(p.value?.[1], unit()), color: PALETTE[i % PALETTE.length], fontSize: 10, offset: [4, 0] },
          data: (series()[n] ?? []).filter((p) => p.y != null).map((p) => [p.x, p.y]),
        })),
      };
    },
  );
  /* the window slides even between runs */
  onMount(() => {
    const t = setInterval(() => {
      if (!c.chart || !timed()) return;
      const now = Date.now();
      c.chart.setOption({ xAxis: { min: now - windowMs(), max: now } }, { lazyUpdate: true });
    }, 250);
    onCleanup(() => clearInterval(t));
  });
  return (
    <div class="w-full">
      <Show when={props.attrs?.title}>
        <div class="text-yellow text-xs mb-1">{props.attrs.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="line" />
      <Show when={!names().length}>
        <div class="text-dim text-xs">no points yet</div>
      </Show>
    </div>
  );
}

export function SparkLine(props) {
  const W = 200;
  const H = 32;
  const vals = () => (props.data?.values ?? []).filter((v) => v != null);
  const d = () => {
    const v = vals();
    if (v.length < 2) return "";
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const span = hi - lo || 1;
    return v.map((y, i) => `${i ? "L" : "M"}${(i / (v.length - 1)) * W},${H - 2 - ((y - lo) / span) * (H - 4)}`).join(" ");
  };
  return (
    <div class="flex items-baseline gap-3">
      <Show when={props.attrs?.title}>
        <span class="text-yellow text-xs">{props.attrs.title}</span>
      </Show>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <path d={d()} fill="none" stroke="#00ffff" stroke-width="1.5" />
      </svg>
      <span class="text-cyan text-xs">{fmt(vals().at(-1), props.attrs?.unit)}</span>
    </div>
  );
}

export function Stat(props) {
  return (
    <div class="flex flex-wrap gap-6">
      <For each={props.data?.tiles ?? []}>
        {(t) => (
          <div>
            <div class="text-dim text-xs">{t.label}</div>
            <div class="text-yellow text-lg">{fmt(t.value, t.unit ?? props.attrs?.unit)}</div>
          </div>
        )}
      </For>
    </div>
  );
}

/* Horizontal bars, largest first, one colour per row, the value at
 * the end of each bar; a live block's bars reorder with an animation. */
export function Bars(props) {
  const bars = () => (props.data?.bars ?? []).slice(0, 40);
  const unit = () => props.attrs?.unit ?? "";
  const c = useChart(
    () => Math.max(60, 22 * bars().length + 30),
    () => ({
      animationDurationUpdate: 400,
      grid: { left: 8, right: 80, top: 4, bottom: 4, containLabel: true },
      tooltip: { trigger: "item", valueFormatter: (v) => fmt(v, unit()) },
      xAxis: { type: "value", show: false },
      yAxis: { type: "category", inverse: true, data: bars().map((b) => b.label), axisLabel: { width: 180, overflow: "truncate" } },
      series: [
        {
          type: "bar",
          barCategoryGap: "25%",
          data: bars().map((b, i) => ({ value: b.value, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
          label: { show: true, position: "right", color: "#f0f0f0", formatter: (p) => fmt(p.value, unit()) },
          showBackground: true,
          backgroundStyle: { color: "#141414" },
        },
      ],
    }),
  );
  return (
    <div class="w-full text-xs">
      <Show when={props.attrs?.title}>
        <div class="text-yellow">{props.attrs.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="bars" />
      <Show when={!bars().length}>
        <div class="text-dim">nothing yet</div>
      </Show>
    </div>
  );
}

export function Table(props) {
  return (
    <div class="overflow-x-auto">
      <Show when={props.attrs?.title}>
        <div class="text-yellow text-xs">{props.attrs.title}</div>
      </Show>
      <table class="text-left text-xs whitespace-nowrap">
        <thead class="text-yellow">
          <tr>
            <For each={props.data?.columns ?? []}>{(c) => <th class="pr-4 font-normal">{c}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.data?.rows ?? []}>
            {(r) => (
              <tr>
                <For each={r}>{(c) => <td class="pr-4 font-mono text-fg">{c == null ? "–" : String(c)}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function Log(props) {
  return (
    <pre class="text-xs text-green whitespace-pre-wrap max-h-48 overflow-auto">{(props.data?.lines ?? []).join("\n")}</pre>
  );
}

export function Canvas(props) {
  let el;
  createEffect(() => {
    const d = props.data;
    if (!el || !d) return;
    const ctx = el.getContext?.("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    for (const op of d.ops ?? []) {
      try {
        if (op[0] === "c" && typeof ctx[op[1]] === "function") ctx[op[1]](...op[2]);
        else if (op[0] === "s") ctx[op[1]] = op[2];
      } catch {
        /* a bad call draws nothing */
      }
    }
  });
  return <canvas ref={el} width={props.data?.width ?? 640} height={props.data?.height ?? 160} class="w-full" style={{ background: "#000", height: "auto" }} />;
}

const TONE = { good: "text-green", warn: "text-orange", bad: "text-red", info: "text-cyan", dim: "text-dim" };
const toneOf = (frac, warn, crit) => (crit != null && frac >= crit ? "#ff0000" : warn != null && frac >= warn ? "#ff9500" : "#00ff00");

/* A fraction of a ceiling, with the thresholds coloured on the arc. */
export function Gauge(props) {
  const d = () => props.data ?? {};
  const frac = () => Math.max(0, Math.min(1, Number(d().frac) || 0));
  const c = useChart(
    () => 170,
    () => {
      const warn = d().warn ?? null;
      const crit = d().crit ?? null;
      const stops = [];
      if (warn != null) stops.push([warn, "#00ff00"]);
      if (crit != null) stops.push([crit, "#ff9500"]);
      stops.push([1, crit != null ? "#ff0000" : warn != null ? "#ff9500" : "#00ff00"]);
      return {
        animationDurationUpdate: 400,
        series: [
          {
            type: "gauge",
            startAngle: 200,
            endAngle: -20,
            min: 0,
            max: 1,
            radius: "95%",
            center: ["50%", "62%"],
            axisLine: { lineStyle: { width: 12, color: stops } },
            progress: { show: true, width: 12, itemStyle: { color: frac() >= (crit ?? 2) ? "#ff0000" : frac() >= (warn ?? 2) ? "#ff9500" : "#00ffff" } },
            pointer: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            title: { show: Boolean(d().label ?? props.attrs?.title), offsetCenter: [0, "30%"], color: "#8a8a8a", fontSize: 11 },
            detail: { valueAnimation: true, offsetCenter: [0, "-5%"], color: "#f0f0f0", fontSize: 20, formatter: () => d().text ?? `${Math.round(frac() * 100)}%` },
            data: [{ value: frac(), name: d().label ?? props.attrs?.title ?? "" }],
          },
        ],
      };
    },
  );
  return <div ref={c.ref} class="w-full max-w-xs" data-chart="gauge" />;
}

export function Heatmap(props) {
  const d = () => props.data ?? {};
  const rows = () => d().rows ?? [];
  const c = useChart(
    () => Math.max(80, 22 * rows().length + 70),
    () => {
      const cols = d().colLabels ?? rows()[0]?.map((_, i) => String(i)) ?? [];
      const rl = d().rowLabels ?? rows().map((_, i) => String(i));
      const data = [];
      rows().forEach((r, y) => r.forEach((v, x) => data.push([x, y, v])));
      const max = Math.max(1, ...rows().flat());
      return {
        animationDurationUpdate: 300,
        grid: { left: 8, right: 60, top: 8, bottom: 28, containLabel: true },
        tooltip: { formatter: (p) => `${rl[p.value[1]]} × ${cols[p.value[0]]}: ${fmt(p.value[2], props.attrs?.unit)}` },
        xAxis: { type: "category", data: cols, axisLabel: { interval: 0, hideOverlap: true } },
        yAxis: { type: "category", data: rl, inverse: true },
        visualMap: { min: 0, max, calculable: false, orient: "vertical", right: 0, top: "center", itemWidth: 8, itemHeight: 80, textStyle: { color: "#8a8a8a" }, inRange: { color: ["#0b1a1a", "#00ffff", "#00ff00", "#ffff00", "#ff9500", "#ff0000"] } },
        series: [{ type: "heatmap", data, label: { show: true, color: "#000", fontSize: 10, formatter: (p) => (p.value[2] ? fmt(p.value[2]) : "") }, itemStyle: { borderColor: "#000", borderWidth: 1 }, emphasis: { itemStyle: { borderColor: "#f0f0f0" } } }],
      };
    },
  );
  return (
    <div class="w-full text-xs">
      <Show when={d().title ?? props.attrs?.title}>
        <div class="text-yellow">{d().title ?? props.attrs?.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="heatmap" />
    </div>
  );
}

/* A distribution: the values binned, one bar per bin, the range of
 * each bin on the axis. */
export function Histogram(props) {
  const d = () => props.data ?? {};
  const unit = () => d().unit ?? props.attrs?.unit ?? "";
  const bins = () => {
    const v = (d().values ?? []).filter((x) => x != null);
    const n = d().bins ?? 16;
    if (!v.length) return { labels: [], counts: [] };
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const w = (hi - lo) / n || 1;
    const counts = new Array(n).fill(0);
    for (const x of v) counts[Math.min(n - 1, Math.floor((x - lo) / w))]++;
    const labels = counts.map((_, i) => fmt(lo + i * w, unit()));
    return { labels, counts };
  };
  const c = useChart(
    () => 180,
    () => ({
      animationDurationUpdate: 300,
      grid: { left: 40, right: 16, top: 8, bottom: 28 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: bins().labels, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", minInterval: 1 },
      series: [{ type: "bar", data: bins().counts, barCategoryGap: "10%", itemStyle: { color: "#00ffff" } }],
    }),
  );
  return (
    <div class="w-full text-xs">
      <Show when={d().title ?? props.attrs?.title}>
        <div class="text-yellow">{d().title ?? props.attrs?.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="histogram" />
      <div class="text-dim">{(d().values ?? []).length} samples</div>
    </div>
  );
}

/* Flows between named nodes, left to right. */
export function Sankey(props) {
  const links = () => (props.data?.links ?? []).filter((l) => l.value > 0 && l.from !== l.to);
  const c = useChart(
    () => 300,
    () => {
      const names = [...new Set(links().flatMap((l) => [l.from, l.to]))];
      return {
        animationDurationUpdate: 400,
        tooltip: { trigger: "item", valueFormatter: (v) => fmt(v, props.attrs?.unit) },
        series: [
          {
            type: "sankey",
            left: 8,
            right: 120,
            top: 8,
            bottom: 8,
            nodeWidth: 10,
            nodeGap: 8,
            emphasis: { focus: "adjacency" },
            data: names.map((n, i) => ({ name: n, itemStyle: { color: PALETTE[i % PALETTE.length], borderWidth: 0 } })),
            links: links().map((l) => ({ source: l.from, target: l.to, value: l.value })),
            lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
            label: { color: "#f0f0f0", fontSize: 10 },
          },
        ],
      };
    },
  );
  return (
    <div class="w-full text-xs">
      <Show when={props.attrs?.title}>
        <div class="text-yellow">{props.attrs.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="sankey" />
      <Show when={!links().length}>
        <div class="text-dim">no flows yet</div>
      </Show>
    </div>
  );
}

/* Any ECharts chart: the option as the body built it, under the
 * page's theme; a snapshot replaces the option whole. */
/* Defaults for legibility under whatever the body wrote: labels that
 * hide when they would overlap, axis labels that do the same, a legend
 * that scrolls past a dozen entries, a tooltip. The body's own choices
 * win where they are set. */
function legible(opt) {
  const out = { animationDurationUpdate: 400, ...opt };
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  out.series = list(opt.series).map((s) => ({
    labelLayout: { hideOverlap: true },
    ...(s.type === "pie" ? { avoidLabelOverlap: true, minShowLabelAngle: 6 } : {}),
    ...s,
  }));
  for (const ax of ["xAxis", "yAxis"]) if (opt[ax]) out[ax] = list(opt[ax]).map((a) => ({ ...a, axisLabel: { hideOverlap: true, overflow: "truncate", width: 140, ...(a.axisLabel ?? {}) } }));
  if (!("tooltip" in opt)) out.tooltip = { trigger: out.series.some((s) => s.type === "line" || s.type === "bar") && opt.xAxis ? "axis" : "item" };
  const names = out.series.flatMap((s) => (Array.isArray(s.data) ? s.data : [])).filter((d) => d && typeof d === "object" && d.name).length;
  if (opt.legend && !opt.legend.type && (names > 12 || out.series.length > 12)) out.legend = { ...opt.legend, type: "scroll" };
  return out;
}

export function Echarts(props) {
  const option = () => props.data?.option ?? null;
  const height = () => Math.max(120, Math.min(900, Number(props.attrs?.height ?? props.height) || 300));
  const c = useChart(height, () => (option() ? legible(option()) : null));
  return (
    <div class="w-full text-xs">
      <Show when={props.attrs?.title}>
        <div class="text-yellow">{props.attrs.title}</div>
      </Show>
      <div ref={c.ref} class="w-full" data-chart="echarts" />
      <Show when={!option()}>
        <div class="text-dim">no option yet: call echarts.option({`{ series: […] }`}) or return one</div>
      </Show>
    </div>
  );
}

/* A kit tree, materialised. Each node kind is one of the drawings
 * above or a layout; `h` nodes are the few plain tags the kit allows.
 * Nothing is interpreted as HTML. */
export function UiTree(props) {
  const node = () => props.node;
  const kidsOf = (n) => (Array.isArray(n.kids) ? n.kids : []);
  const n = node();
  if (!n || typeof n !== "object") return null;
  switch (n.k) {
    case "text":
      return <span class={TONE[n.tone] ?? "text-fg"}>{n.text}</span>;
    case "title":
      return <div class="text-yellow text-xs">{n.text}</div>;
    case "row":
      return (
        <div class="flex flex-wrap gap-4 items-start">
          <For each={kidsOf(n)}>{(k) => <UiTree node={k} />}</For>
        </div>
      );
    case "col":
      return (
        <div class="flex flex-col gap-2">
          <For each={kidsOf(n)}>{(k) => <UiTree node={k} />}</For>
        </div>
      );
    case "grid":
      return (
        <div class="grid gap-3" style={{ "grid-template-columns": `repeat(${n.cols}, minmax(0, 1fr))` }}>
          <For each={kidsOf(n)}>{(k) => <UiTree node={k} />}</For>
        </div>
      );
    case "tile":
      return (
        <div>
          <div class="text-dim text-xs">{n.label}</div>
          <div class="text-yellow text-lg">{fmt(n.value, n.unit)}</div>
        </div>
      );
    case "badge":
      return <span class={`${TONE[n.tone] ?? "text-cyan"} border border-rule px-1 text-xs`}>{n.text}</span>;
    case "meter":
      return (
        <div class="text-xs">
          <Show when={n.label}>
            <span class="text-dim">{n.label} </span>
          </Show>
          <span class="inline-block align-middle w-64 max-w-full h-2 bg-rule">
            <span class="block h-2" style={{ width: `${Math.round(n.frac * 100)}%`, background: toneOf(n.frac, n.warn, n.crit) }} />
          </span>
          <span class="text-fg"> {Math.round(n.frac * 100)}%</span>
        </div>
      );
    case "gauge":
      return <Gauge data={{ frac: n.frac, label: n.label, text: n.text }} />;
    case "spark":
      return <SparkLine data={{ values: n.values }} attrs={{ title: n.label, unit: n.unit }} />;
    case "lines":
      return <LineChart data={{ series: n.series }} attrs={{ title: n.title, unit: n.unit }} />;
    case "bars":
      return <Bars data={{ bars: n.bars }} attrs={{ title: n.title, unit: n.unit }} />;
    case "table":
      return <Table data={{ columns: n.columns, rows: n.rows }} attrs={{ title: n.title }} />;
    case "list":
      return (
        <ul class="list-disc pl-5 text-xs text-fg">
          <For each={n.items}>{(it) => <li>{it}</li>}</For>
        </ul>
      );
    case "kv":
      return (
        <table class="text-xs">
          <tbody>
            <For each={n.pairs}>
              {([k, v]) => (
                <tr>
                  <td class="pr-4 text-dim">{k}</td>
                  <td class="font-mono text-fg">{String(v)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      );
    case "code":
      return <pre class="text-xs text-green whitespace-pre overflow-x-auto border border-dim p-2">{n.text}</pre>;
    case "hex":
      return <HexDump hex={n.hex} title={n.title} />;
    case "heat":
      return <Heatmap data={{ rows: n.rows, rowLabels: n.rowLabels, colLabels: n.colLabels, title: n.title }} />;
    case "hist":
      return <Histogram data={{ values: n.values, bins: n.bins, title: n.title, unit: n.unit }} />;
    case "h":
      return (
        <Dynamic component={n.tag} class={n.class} title={n.title}>
          <For each={kidsOf(n)}>{(k) => <UiTree node={k} />}</For>
        </Dynamic>
      );
    case "sankey":
      return <Sankey data={{ links: n.links }} attrs={{ title: n.title, unit: n.unit }} />;
    case "echarts":
      return <Echarts data={{ option: n.option }} attrs={{ title: n.title }} height={n.height} />;
    default:
      return <span class="text-red text-xs">unknown node {String(n.k)}</span>;
  }
}

function HexDump(props) {
  const lines = () => xxd(props.hex ?? "");
  return (
    <div class="font-mono text-xs">
      <Show when={props.title}>
        <div class="text-yellow">{props.title}</div>
      </Show>
      <For each={lines()}>
        {(l) => (
          <div class="whitespace-pre">
            <span class="text-dim">{l.offset}: </span>
            <For each={l.cells}>{(b, i) => (b ? <span class={b.cls}>{b.hex}{i() === 7 ? "  " : " "}</span> : <span>{i() === 7 ? "    " : "   "}</span>)}</For>
            {" "}
            <For each={l.ascii}>{(a) => <span class={a.cls}>{a.ch}</span>}</For>
          </div>
        )}
      </For>
    </div>
  );
}

export function Ui(props) {
  return (
    <div>
      <Show when={props.attrs?.title}>
        <div class="text-yellow text-xs mb-1">{props.attrs.title}</div>
      </Show>
      <Show when={props.data?.tree} fallback={<div class="text-dim text-xs">nothing rendered: call ui.render(tree) or return a tree</div>}>
        <UiTree node={props.data.tree} />
      </Show>
    </div>
  );
}

export function Watch(props) {
  const d = () => props.data ?? {};
  return (
    <div class="text-xs">
      <span class="text-yellow">watching</span> <span class="text-dim">{props.attrs?.title ?? ""}</span>
      <span class="text-dim"> · fired {d().fires ?? 0} time{d().fires === 1 ? "" : "s"}</span>
      <Show when={d().last}>
        <span class="text-dim"> · last at {new Date(d().last.at).toTimeString().slice(0, 8)}: </span>
        <span class="text-cyan">{typeof d().last.payload === "string" ? d().last.payload : JSON.stringify(d().last.payload)}</span>
      </Show>
      <Show when={d().stopped}>
        <span class="text-dim"> · stopped itself</span>
      </Show>
    </div>
  );
}

export function Done(props) {
  return (
    <div class="text-xs text-dim">
      done — stopped {props.data?.stopped ?? 0} block{props.data?.stopped === 1 ? "" : "s"} and watch{props.data?.stopped === 1 ? "" : "es"}
    </div>
  );
}

export const WIDGETS = { watch: Watch, done: Done, echarts: Echarts, lineChart: LineChart, sparkLine: SparkLine, stat: Stat, bars: Bars, table: Table, log: Log, canvas: Canvas, gauge: Gauge, heatmap: Heatmap, histogram: Histogram, sankey: Sankey, ui: Ui };
