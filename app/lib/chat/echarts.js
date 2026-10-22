/* ECharts, loaded at runtime from the page's own public files rather
 * than bundled: the prebuilt module is 1.1 MB minified, which the
 * browser caches once, and the dev bundler never has to chew through
 * it (inline sourcemaps made that a 7.5 MB island and a slow first
 * serve). The import is built out of a string so the bundler leaves
 * it alone. Browser side.
 *
 * The chart's colours are the page's, read off the stylesheet, so a
 * chart is in whatever theme the page is in. A theme is baked into an
 * ECharts instance at init, so when the page's theme changes every
 * mounted chart is started again in the new one and handed the option
 * it last had; and `colour`/`palette` read a signal that ticks on the
 * change, so a widget's option is rebuilt with the new colours too. */
import { createSignal } from "solid-js";

import { colour as read, onTheme } from "../theme.js";

const [tick, bump] = createSignal(0);
let lib = null; /* echarts, once loaded */
if (typeof window !== "undefined") {
  onTheme(() => {
    /* first, so the mounts that listen after this one re-init into the new theme */
    if (lib) lib.registerTheme("walkshop", theme());
    bump((n) => n + 1);
  });
}

/** One colour of the page's palette, reactive: a build that calls it is redone when the theme changes. */
export const colour = (name) => (tick(), read(name));
/** The series colours, in the order the palette's brightness suggests. */
export const palette = () => ["green", "cyan", "magenta", "yellow", "orange", "blue", "pink", "red"].map(colour);
/** The colour of series `i`. */
export const hue = (i) => {
  const p = palette();
  return p[i % p.length];
};

const theme = () => {
  const dim = read("dim");
  const rule = read("rule");
  const fg = read("fg");
  return {
    color: ["green", "cyan", "magenta", "yellow", "orange", "blue", "pink", "red"].map(read),
    backgroundColor: "transparent",
    textStyle: { color: dim, fontFamily: "inherit", fontSize: 11 },
    title: { textStyle: { color: read("yellow"), fontWeight: "normal", fontSize: 12 } },
    legend: { textStyle: { color: dim }, inactiveColor: rule, pageTextStyle: { color: dim } },
    tooltip: { backgroundColor: read("mode"), borderColor: rule, textStyle: { color: fg, fontFamily: "inherit", fontSize: 11 }, axisPointer: { lineStyle: { color: dim }, crossStyle: { color: dim }, label: { backgroundColor: rule, color: fg } } },
    categoryAxis: { axisLine: { lineStyle: { color: rule } }, axisTick: { lineStyle: { color: rule } }, axisLabel: { color: dim }, splitLine: { show: false } },
    valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: dim }, splitLine: { lineStyle: { color: read("mode") } } },
    timeAxis: { axisLine: { lineStyle: { color: rule } }, axisTick: { lineStyle: { color: rule } }, axisLabel: { color: dim }, splitLine: { lineStyle: { color: read("mode") } } },
    line: { smooth: 0.15, symbol: "none", lineStyle: { width: 2 } },
    gauge: { axisLine: { lineStyle: { width: 10 } } },
  };
};

let loading = null;
export function loadEcharts() {
  loading ??= new Function("u", "return import(u)")("/vendor/echarts.esm.min.js").then((echarts) => {
    echarts.registerTheme("walkshop", theme());
    lib = echarts;
    return echarts;
  });
  return loading;
}

export const fmt = (v, unit) => (v == null ? "–" : `${typeof v === "number" ? (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) : v}${unit ? ` ${unit}` : ""}`);

/** A chart in `host`, resized with it, once the library is here. */
export async function mount(host, height) {
  /* a count the wire test reads: a chart mounted once stays mounted */
  if (typeof window !== "undefined") window.__chartMounts = (window.__chartMounts ?? 0) + 1;
  const echarts = await loadEcharts();
  host.style.height = `${height}px`;
  let chart = echarts.init(host, "walkshop", { renderer: "canvas" });
  let last = null; /* the option in force, for the instance that replaces this one */
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => chart.resize()) : null;
  ro?.observe(host);
  const off = onTheme(() => {
    chart.dispose();
    chart = echarts.init(host, "walkshop", { renderer: "canvas" });
    if (last) chart.setOption(last, { notMerge: true });
  });
  return {
    get chart() {
      return chart;
    },
    setOption(option, how) {
      last = option;
      chart.setOption(option, how);
    },
    setHeight(h) {
      if (host.style.height !== `${h}px`) {
        host.style.height = `${h}px`;
        chart.resize();
      }
    },
    dispose() {
      off();
      ro?.disconnect();
      chart.dispose();
    },
  };
}
