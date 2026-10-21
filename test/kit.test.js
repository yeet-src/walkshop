import assert from "node:assert/strict";
import { test } from "node:test";

import { bounded, kit } from "../app/lib/chat/kit.js";
import { make } from "../app/lib/chat/objects.js";

test("the kit builds plain nodes, coerces loosely, and caps sizes", () => {
  const t = kit.col(kit.title("x"), kit.row(kit.tile("a", "7", "ms"), kit.badge("ok", "good")), kit.bars({ a: 1, b: "2" }), kit.table([{ a: 1, b: { c: 2 } }]), "plain", null, false);
  assert.equal(t.k, "col");
  assert.deepEqual(t.kids.map((k) => k.k), ["title", "row", "bars", "table", "text"]);
  assert.deepEqual(t.kids[2].bars, [{ label: "a", value: 1 }, { label: "b", value: 2 }]);
  assert.deepEqual(t.kids[3], { k: "table", columns: ["a", "b"], rows: [[1, '{"c":2}']], title: undefined });
  assert.equal(kit.h("script", {}, "x").k, "text", "a tag outside the kit is refused");
  assert.equal(kit.h("div", { class: "p", onclick: "x" }, "hi").kids[0].text, "hi");
  assert.equal(kit.h("div", { class: "p", onclick: "x" }, "hi").onclick, undefined);
  assert.equal(kit.meter(7).frac, 1);
  assert.equal(kit.heat([[1, "2"], [3]]).rows[0][1], 2);
});

test("bounded cuts a runaway tree", () => {
  let t = kit.text("leaf");
  for (let i = 0; i < 3000; i++) t = kit.col(t);
  const out = bounded(t);
  let depth = 0;
  let n = out;
  while (n && n.k === "col") (n = n.kids[0]), depth++;
  assert.ok(depth < 2100);
});

test("the ui object takes a rendered or a returned tree; the new objects collect", () => {
  const ui = make("ui", {});
  ui.api.render(ui.api.row(ui.api.tile("n", 3)));
  assert.equal(ui.snapshot().tree.k, "row");
  const ui2 = make("ui", {});
  ui2.take(kit.col(kit.text("returned")));
  assert.equal(ui2.snapshot().tree.kids[0].text, "returned");
  const g = make("gauge", { warn: 0.8 });
  g.api.set(0.5, "cpu");
  assert.deepEqual(g.snapshot(), { frac: 0.5, label: "cpu", text: null, warn: 0.8, crit: null });
  const hm = make("heatmap", {});
  hm.api.add("a", "x", 1);
  hm.api.add("a", "x", 2);
  hm.api.cell("b", "y", 5);
  assert.deepEqual(hm.snapshot(), { rows: [[3, 0], [0, 5]], rowLabels: ["a", "b"], colLabels: ["x", "y"] });
  const h = make("histogram", { bins: 4 });
  h.api.values([1, 2, "3", "x"]);
  assert.deepEqual(h.snapshot(), { values: [1, 2, 3], bins: 4 });
});

test("a line chart keeps its history across runs and averages a run's pushes per series", () => {
  const c = make("lineChart", {});
  c.api.push("a", 10);
  c.api.push("a", 30);
  c.api.push("b", 5);
  c.flush();
  c.api.push("a", 50);
  c.flush();
  const s = c.snapshot().series;
  assert.deepEqual(s.a.map((p) => p.y), [20, 50]);
  assert.deepEqual(s.b.map((p) => p.y), [5]);
  const sk = make("sankey", {});
  sk.api.flow(":443", "1.1.1.1", 10);
  sk.api.flow(":443", "1.1.1.1", 5);
  sk.api.flow(":80", "2.2.2.2", 1);
  assert.deepEqual(sk.snapshot().links, [{ from: ":443", to: "1.1.1.1", value: 15 }, { from: ":80", to: "2.2.2.2", value: 1 }]);
  assert.equal(kit.sankey([{ from: "a", to: "b", value: "3" }]).links[0].value, 3);
});

test("a watch fires on a returned value or fire(), not on undefined; done is known", () => {
  const w = make("watch", {});
  w.reset();
  w.take(undefined);
  assert.equal(w.fired(), null);
  w.take({ slow: 1 });
  assert.deepEqual(w.fired(), { slow: 1 });
  w.reset();
  w.api.fire("hot");
  assert.equal(w.fired(), "hot");
  assert.equal(w.stopped(), false);
  w.api.stop();
  assert.equal(w.stopped(), true);
  assert.ok(make("done", {}));
});

test("an echarts block keeps data and drops functions; the kit node is bounded", () => {
  const e = make("echarts", {});
  e.api.option({ series: [{ type: "pie", data: [{ name: "a", value: 1n }], label: { formatter: () => "x" } }], tooltip: { formatter: "{b}" } });
  assert.deepEqual(e.snapshot().option, { series: [{ type: "pie", data: [{ name: "a", value: 1 }], label: {} }], tooltip: { formatter: "{b}" } });
  const e2 = make("echarts", {});
  e2.take({ series: [{ type: "bar", data: [1, 2] }] });
  assert.equal(e2.snapshot().option.series[0].type, "bar");
  assert.equal(kit.echarts({ series: [] }, { height: 5000 }).height, 900);
});
