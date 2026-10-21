/* Bytes as a coloured xxd dump. Pure, browser-safe.
 *
 * Nine byte classes on the terminal palette: NUL dim, 0xff red,
 * whitespace cyan, other control yellow, digits orange, upper case
 * green, lower case blue, other printable white, high bytes magenta.
 * The same class goes on the hex pair and on its character, so the eye
 * can cross from one column to the other, and a protocol's shape — a
 * header of ASCII, a length, a run of zeros, a TLS record of high
 * bytes — reads as bands of colour. */

export const byteClass = (b) => {
  if (b === 0) return "text-dim";
  if (b === 0xff) return "text-red";
  if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) return "text-cyan";
  if (b < 0x20 || b === 0x7f) return "text-yellow";
  if (b >= 0x30 && b <= 0x39) return "text-orange";
  if (b >= 0x41 && b <= 0x5a) return "text-green";
  if (b >= 0x61 && b <= 0x7a) return "text-blue";
  if (b < 0x7f) return "text-fg";
  return "text-magenta";
};

export const byteChar = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0 ? "0" : b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d ? "_" : "·");

/** `xxd -g 1` lines of a hex string, sixteen bytes a line, at least `lines` lines. */
export function xxd(hex, lines = 0) {
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const out = [];
  for (let o = 0; o < bytes.length || out.length < lines; o += 16) {
    const chunk = bytes.slice(o, o + 16);
    const cells = [];
    for (let g = 0; g < 16; g++) cells.push(g < chunk.length ? { hex: chunk[g].toString(16).padStart(2, "0"), cls: byteClass(chunk[g]) } : null);
    out.push({ offset: o.toString(16).padStart(8, "0"), cells, ascii: chunk.map((b) => ({ ch: byteChar(b), cls: byteClass(b) })) });
    if (o + 16 >= bytes.length && out.length >= lines) break;
  }
  return out;
}

/** A hex string as text: printable bytes as themselves, newlines and
 * tabs kept, a carriage return dropped, anything else a middle dot. */
export function textOf(hex) {
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (b === 0x0a) out += "\n";
    else if (b === 0x09) out += "  ";
    else if (b === 0x0d) continue;
    else out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
  }
  return out;
}

/** Whether bytes read as text: no NUL in the first 512, and at least
 * 85% printable (newlines and tabs count). */
export function looksText(hex) {
  const n = Math.min(hex.length, 1024);
  if (n === 0) return false;
  let ok = 0;
  let total = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    total++;
    if (b === 0) return false;
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) ok++;
  }
  return ok / total >= 0.85;
}
