/* The isolate's side of the data lane: a frame on the console, in the
 * view's own framing, so the dev server's tap strips it and the page's
 * client ignores it (an op it does not know) while the islands' own
 * sockets read it. Plain module, isolate only. */

const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const push = (frame) => console.log(`${OSC_OPEN}${ascii(JSON.stringify(frame))}${OSC_CLOSE}`);
