/* ECharts, loaded at runtime from the page's own public files rather
 * than bundled: the prebuilt module is 1.1 MB minified, which the
 * browser caches once, and the dev bundler never has to chew through
 * it (inline sourcemaps made that a 7.5 MB island and a slow first
 * serve). The import is built out of a string so the bundler leaves
 * it alone. Browser side. The page's theme is registered on load. */

export const PALETTE = ["#00ff00", "#00ffff", "#ff00ff", "#ffff00", "#ff9500", "#29b6ff", "#ff7eb6", "#ff0000", "#80ff00", "#8000ff"];
const DIM = "#8a8a8a";
const RULE = "#2a2a2a";
const FG = "#f0f0f0";

let loading = null;
export function loadEcharts() {
  loading ??= new Function("u", "return import(u)")("/vendor/echarts.esm.min.js").then((echarts) => {
    echarts.registerTheme("walkshop", {
      color: PALETTE,
      backgroundColor: "transparent",
      textStyle: { color: DIM, fontFamily: "inherit", fontSize: 11 },
      title: { textStyle: { color: "#ffff00", fontWeight: "normal", fontSize: 12 } },
      legend: { textStyle: { color: DIM }, inactiveColor: "#444", pageTextStyle: { color: DIM } },
      tooltip: { backgroundColor: "#141414", borderColor: RULE, textStyle: { color: FG, fontFamily: "inherit", fontSize: 11 }, axisPointer: { lineStyle: { color: DIM }, crossStyle: { color: DIM }, label: { backgroundColor: RULE, color: FG } } },
      categoryAxis: { axisLine: { lineStyle: { color: RULE } }, axisTick: { lineStyle: { color: RULE } }, axisLabel: { color: DIM }, splitLine: { show: false } },
      valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: DIM }, splitLine: { lineStyle: { color: "#1a1a1a" } } },
      timeAxis: { axisLine: { lineStyle: { color: RULE } }, axisTick: { lineStyle: { color: RULE } }, axisLabel: { color: DIM }, splitLine: { lineStyle: { color: "#1a1a1a" } } },
      line: { smooth: 0.15, symbol: "none", lineStyle: { width: 2 } },
      gauge: { axisLine: { lineStyle: { width: 10 } } },
    });
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
  const chart = echarts.init(host, "walkshop", { renderer: "canvas" });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => chart.resize()) : null;
  ro?.observe(host);
  return {
    chart,
    setHeight(h) {
      if (host.style.height !== `${h}px`) {
        host.style.height = `${h}px`;
        chart.resize();
      }
    },
    dispose() {
      ro?.disconnect();
      chart.dispose();
    },
  };
}
