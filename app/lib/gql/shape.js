/* Rows back into the selection's nesting. Pure.
 *
 * A row is flat — prefix columns on the row, VM columns in
 * `row.values` keyed by the dotted position — and the plan's layout
 * says where each one goes, so `{ tcp { rx_opt { ts_recent } } }`
 * comes back as `{ tcp: { rx_opt: { ts_recent: 1234 } } }`. */

/* JSON-safe prefix values. */
const prefixValue = (row, name) => {
  const v = row[name];
  if (typeof v === "bigint") return v.toString();
  return v ?? null;
};

export function shapeRow(row, layout) {
  const out = {};
  for (const [key, node] of Object.entries(layout)) {
    if (node.kind === "prefix") out[key] = prefixValue(row, node.name);
    else if (node.kind === "vm") out[key] = row.values[node.name] ?? null;
    else out[key] = shapeRow(row, node.fields);
  }
  return out;
}

export const shapeRows = (rows, layout) => rows.map((r) => shapeRow(r, layout));

/** The flat column list a table wants: `[{ key, path, source, name }]` in
 * selection order — `source` is prefix or vm, `name` the prefix column or
 * the VM field the value comes from. */
export function columnsOf(layout, prefix = []) {
  const out = [];
  for (const [key, node] of Object.entries(layout)) {
    if (node.kind === "object") out.push(...columnsOf(node.fields, [...prefix, key]));
    else out.push({ key: [...prefix, key].join("."), path: [...prefix, key], source: node.kind, name: node.name });
  }
  return out;
}

/** One shaped row flattened to the column list, for a table. */
export function flatten(shaped, columns) {
  const out = {};
  for (const c of columns) {
    let v = shaped;
    for (const p of c.path) v = v?.[p];
    if (v === undefined && c.key in (shaped ?? {})) v = shaped[c.key];
    out[c.key] = v ?? null;
  }
  return out;
}
