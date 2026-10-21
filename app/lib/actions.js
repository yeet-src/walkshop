"use server";

/* The one hop an island has: into Node, which asks the isolate. Every
 * call here returns quickly; a run's life is on the other side. */

import { pathToFileURL } from "node:url";

import { closeRun, listRuns, pollRun, startRun, stopRun } from "./session.js";

/* Whether the app runs in direct mode, from the project's config: then
 * the isolate's console lane is a WebSocket the browser can dial, and a
 * run pushes its rows there instead of waiting to be polled. */
let directMode = null;
async function isDirect() {
  if (directMode !== null) return directMode;
  try {
    const cfg = (await import(pathToFileURL(`${process.cwd()}/yeetkit.config.js`).href)).default ?? {};
    directMode = Boolean(cfg.direct);
  } catch {
    directMode = false;
  }
  return directMode;
}

export async function start(id, text, opts = {}) {
  return startRun(id ?? null, String(text ?? ""), { push: await isDirect(), forever: opts.forever === "open" ? "open" : opts.forever !== false });
}

/** Where the rows stream from in direct mode: the console lane's port. */
export async function lanes() {
  try {
    const cfg = (await import(pathToFileURL(`${process.cwd()}/yeetkit.config.js`).href)).default ?? {};
    const ws = Number(process.env.YEETKIT_WS ?? cfg.ws ?? 3001);
    return { direct: Boolean(cfg.direct), console: cfg.console != null ? Number(cfg.console) : ws + 1 };
  } catch {
    return { direct: false, console: null };
  }
}

export async function stop(id) {
  return stopRun(id);
}

export async function close(id) {
  return closeRun(id);
}

export async function list() {
  return listRuns();
}

export async function poll(id, after) {
  return pollRun(id, after ?? {});
}
