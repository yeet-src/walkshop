"use yeet";

/* The attached objects, one per (object, scope), shared by every
 * query.
 *
 * A query asks for rows from a root; the registry finds or attaches
 * the object that serves it and runs the capture. Attaching is slow
 * (a load, a verify, the hook) and a capture is short, so handles
 * stay attached after their last user and go away after a linger —
 * long enough that a page polling every few seconds never reloads,
 * short enough that an idle app stops tracing within a minute.
 */

import { ROOTS } from "../roots.js";
import { attachObject, objectSpec } from "./attach.js";

const LINGER_MS = 60_000;
/* The app's own ports, so a query never watches itself. */
const OWN_PORTS = [3600, 3601, 3602];

const handles = new Map();
const errors = [];

const note = (error) => {
  errors.unshift({ at: Date.now(), message: String(error?.message ?? error) });
  if (errors.length > 20) errors.length = 20;
};

/* xdp attaches per interface set and https per binary and pid; tcx
 * once for every interface. */
function keyOf(root, args) {
  if (root.object === "xdp") return `xdp:${(args.iface ?? []).map(String).sort().join(",")}`;
  if (root.object === "https") return `https:${args.binary ?? ""}:${args.pid ?? ""}`;
  return "tcx";
}

async function acquire(root, args) {
  const key = keyOf(root, args);
  let entry = handles.get(key);
  if (!entry) {
    const scope = {};
    if (root.object === "xdp") scope.iface = args.iface;
    if (root.object === "https") {
      if (args.binary) scope.binary = args.binary;
      if (args.pid) scope.pid = args.pid;
    }
    const pending = attachObject(root.object, objectSpec(root.object), { scope, ignorePorts: OWN_PORTS, onError: note });
    entry = { key, handle: pending, users: 0, timer: null, until: null, since: Date.now() };
    handles.set(key, entry);
    try {
      entry.handle = await pending;
    } catch (error) {
      handles.delete(key);
      note(error);
      throw error;
    }
  } else {
    entry.handle = await entry.handle;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.until = null;
  }
  entry.users++;
  return entry;
}

function release(entry) {
  entry.users--;
  if (entry.users > 0) return;
  entry.until = Date.now() + LINGER_MS;
  entry.timer = setTimeout(async () => {
    if (entry.users > 0) return;
    handles.delete(entry.key);
    try {
      await entry.handle.stop();
    } catch (error) {
      note(error);
    }
  }, LINGER_MS);
}

/**
 * Run compiled `fields` on `rootName` with the query's `args`
 * (limit, ms, every, ports, data, pid, proto, iface, binary). Resolves
 * to the rows.
 */
export async function capture(rootName, fields, args, onRow, stop) {
  const root = ROOTS[rootName];
  const entry = await acquire(root, args);
  try {
    return await entry.handle.capture(root.slot, fields, {
      limit: args.limit,
      ms: args.ms,
      every: args.every,
      ports: args.ports,
      data: args.data,
      pid: args.pid,
      proto: args.proto,
      iface: root.object === "tcx" ? args.iface : undefined,
      onRow,
      stop,
    });
  } finally {
    release(entry);
  }
}

/** What is attached right now, with the kernel's counters. */
export async function status() {
  const out = [];
  for (const entry of handles.values()) {
    const handle = await Promise.resolve(entry.handle).catch(() => null);
    out.push({ key: entry.key, users: entry.users, since: entry.since, until: entry.until, stats: handle?.stats ? await handle.stats().catch(() => null) : null });
  }
  return { attached: out, errors };
}

/** Detach everything now. */
export async function stopAll() {
  for (const entry of [...handles.values()]) {
    handles.delete(entry.key);
    if (entry.timer) clearTimeout(entry.timer);
    await Promise.resolve(entry.handle)
      .then((h) => h.stop())
      .catch(note);
  }
}
