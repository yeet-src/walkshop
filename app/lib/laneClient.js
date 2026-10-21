/* The browser's side of the data lane: a second WebSocket to the
 * isolate's console port, read for the frames the app pushes. The port
 * comes from the page's own boot script (direct mode names it there).
 * Reconnects on its own; the dev server restarts the isolate on every
 * edit. Browser only. */

const OPEN = "\x1b]7880;";
const CLOSE = "\x07";

export function lanePort() {
  for (const sc of document.scripts) {
    const m = /location\.hostname\}:(\d+)\//.exec(sc.textContent ?? "");
    if (m) return Number(m[1]);
  }
  return null;
}

/** Open the lane; `onFrame(obj)` gets every parsed frame. Returns a closer. */
export function openLane(onFrame, { port = lanePort() } = {}) {
  if (!port) return () => {};
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.hostname}:${port}/`;
  let closed = false;
  let socket = null;
  let backoff = 250;
  let pending = "";
  const dial = () => {
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      backoff = 250;
    };
    ws.onmessage = (ev) => {
      pending += typeof ev.data === "string" ? ev.data : "";
      for (;;) {
        const s0 = pending.indexOf(OPEN);
        if (s0 < 0) {
          pending = pending.slice(-OPEN.length);
          return;
        }
        const e0 = pending.indexOf(CLOSE, s0);
        if (e0 < 0) {
          pending = pending.slice(s0);
          return;
        }
        const body = pending.slice(s0 + OPEN.length, e0);
        pending = pending.slice(e0 + CLOSE.length);
        try {
          onFrame(JSON.parse(body));
        } catch {
          /* not ours */
        }
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(dial, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    ws.onerror = () => {};
  };
  dial();
  return () => {
    closed = true;
    socket?.close();
  };
}
