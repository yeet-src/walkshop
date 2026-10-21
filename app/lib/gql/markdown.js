/* Rows as a Markdown table, for a client that asked for one. Pure.
 *
 * A cell is one line: a newline becomes `⏎`, a pipe is escaped, a
 * null is empty. The header is the run's columns in selection order;
 * a row that carries a key the header does not have (a pipeline that
 * added one after the header went out) is cut to the header. */

const cell = (v) => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\r?\n/g, "⏎").replace(/\|/g, "\\|");
};

/** `| a | b |` + `|---|---|` for `columns` (`[{ key }]` or strings). */
export function header(columns) {
  const keys = columns.map((c) => (typeof c === "string" ? c : c.key));
  return `| ${keys.join(" | ")} |\n|${keys.map(() => "---").join("|")}|`;
}

/** One row in `columns` order. */
export function line(row, columns) {
  return `| ${columns.map((c) => cell(row[typeof c === "string" ? c : c.key])).join(" | ")} |`;
}

/** A whole table, for the non-streaming reply. */
export function table(rows, columns) {
  return [header(columns), ...rows.map((r) => line(r, columns))].join("\n");
}
