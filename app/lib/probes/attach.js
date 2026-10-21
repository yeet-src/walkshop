"use yeet";

/* Loading a walkshop object and running programs on it.
 *
 * Every object is the same VM behind a different prologue, so one
 * loader serves all three: bind the shared maps, attach the hook the
 * object's kind needs, subscribe to the ring, and expose `capture()`
 * per slot. An object attaches once and stays quiet (every slot's
 * nfields 0) until a program is applied; applying writes the field
 * programs into the `programs` map, then arms the slot — a map update,
 * never a reload. One program per slot at a time, so captures on a
 * slot are serialised; the tcx object's two slots run concurrently.
 *
 * Several captures may share a slot: their fields are merged into one
 * program (see `rebuild`), the kernel filters are the loosest any of
 * them asked for, and each gets only its own rows and fields back.
 */

import { ArrayMap, BpfObject, DataSec, HashMap, RingBuf } from "yeet:bpf";

import { decodeEvent } from "../vm/decode.js";
import { EMPTY_PROGRAM, MAX_FIELDS, MAX_SLOTS, ROOT_ID, listing, program } from "../vm/ops.js";

/* Where the linked objects are: `make bpf` links bpf/<name>/ into
 * bin/<name>.bpf.o at the project root. The bundle runs one level
 * below it (.yeetkit/ in dev, dist/ in production); unbundled, as a
 * `yeet run scripts/…` import, this file is three levels down. */
const HERE = import.meta.dirname ?? ".";
const ROOT = /app\/lib\/probes\/?$/.test(HERE) ? "../../.." : "..";
export const objectSpec = (name, base = HERE) => ({ exe: `${base === HERE ? ROOT : ".."}/bin/${name}.bpf.o`, base });

/** A stop token: `abort()` ends a capture early; `on(fn)` hears it. The
 * isolate has no AbortController, so this is the whole thing. */
export function stopToken() {
  const listeners = [];
  return {
    aborted: false,
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      for (const fn of listeners.splice(0)) fn();
    },
    on(fn) {
      if (this.aborted) fn();
      else listeners.push(fn);
    },
  };
}

/** The host's interfaces from the graph: `[{ name, index }]`. */
export async function interfaces() {
  const r = await yeet.graph.query(`{ network_interfaces { name index } }`).catch(() => null);
  return r?.data?.network_interfaces ?? [];
}

/* The hook each object kind needs. `scope` is what the query asked for. */
async function attachments(kind, builder, scope) {
  if (kind === "xdp") {
    const ifaces = await interfaces();
    const want = scope.iface ?? [];
    const indexes = want.map((w) => ifaces.find((i) => i.name === String(w) || i.index === Number(w))?.index).filter(Boolean);
    if (!indexes.length) throw new Error(`xdp needs an interface; have ${ifaces.map((i) => i.name).join(", ")}`);
    return { builder: builder.attach("walk_xdp", { kind: "xdp", ifindex: indexes }), ifindex: indexes };
  }
  if (kind === "tcx") {
    const ifaces = await interfaces();
    const want = scope.iface?.length ? ifaces.filter((i) => scope.iface.includes(i.name) || scope.iface.includes(i.index)) : ifaces;
    const ifindex = want.map((i) => i.index);
    const net = { net: { handle: { kind: "host" }, ...(ifindex.length ? { ifindex } : {}) } };
    return { builder: builder.attach("walk_ingress", { kind: "tcx", ...net }).attach("walk_egress", { kind: "tcx", ...net }), ifindex, lo: ifaces.find((i) => i.name === "lo")?.index ?? 1 };
  }
  if (kind === "https") {
    const binary = scope.binary ?? "/usr/lib/libssl.so.3";
    const pid = scope.pid;
    const spec = (symbol) => ({ kind: "uprobe", binary, symbol, ...(pid ? { pid } : {}) });
    return {
      builder: builder.attach("ssl_write", spec("SSL_write")).attach("ssl_read_enter", spec("SSL_read")).attach("ssl_read_exit", spec("SSL_read")),
      binary,
    };
  }
  throw new Error(`unknown object kind \`${kind}\``);
}

/**
 * Attach one object. `kind` is xdp | tcx | https; `object` is `{ exe,
 * base? }`; `scope` carries the attach-time choices (iface, binary,
 * pid). Returns a handle with `capture(slot, fields, opts)`, `stats()`
 * and `stop()`.
 */
export async function attachObject(kind, object, { scope = {}, onError, ignorePorts = [] } = {}) {
  const bss = `${kind}.bss`;
  let builder = new BpfObject(object)
    .bind("events", { kind: "ringbuf", btf_struct: "walk_event" })
    .bind("programs", { kind: "array" })
    .bind("focus_ports", { kind: "hash_map" })
    .bind("ignore_ports", { kind: "hash_map" })
    .bind(bss, { kind: "data" });
  const attached = await attachments(kind, builder, scope);
  const control = await attached.builder.start();

  const programs = new ArrayMap(control, "programs");
  const ignored = new HashMap(control, "ignore_ports");
  const focused = new HashMap(control, "focus_ports");
  const data = new DataSec(control, bss);
  for (const port of ignorePorts) await ignored.update(Number(port), 1);
  if (kind === "tcx") await data.patch({ lo_ifindex: attached.lo });

  /* Per slot: its subscribers, and the union of their fields that the
   * kernel actually runs. Several runs may watch one root at once —
   * two tabs, a page and an API call — but a slot holds one program,
   * so the programs are merged: identical fields (same ops) are shared,
   * distinct ones take their own entry, and the whole set must fit the
   * VM's MAX_FIELDS. Rows are decoded once by the union and handed to
   * each subscriber with only its fields, under its names. Every change
   * to the set rewrites the slot and bumps its generation, so rows
   * already in the ring are dropped rather than misread. */
  const slots = Array.from({ length: MAX_SLOTS }, () => ({ subs: new Map(), union: [], gen: 0 }));
  let generation = 0;
  let nextSub = 0;
  let chain = Promise.resolve(); /* rebuilds are serialised: they interleave map writes */
  const serial = (fn) => {
    const turn = chain.then(fn, fn);
    chain = turn.catch(() => {});
    return turn;
  };

  const signature = (f) => `${listing([...f.pre, ...f.body])}|${f.nextOff ?? 0}|${f.maxIters ?? 1}|${JSON.stringify(f.decode)}`;

  /* Recompute a slot's union and write it to the kernel. Throws when it
   * does not fit; the caller removes the newest subscriber and tries
   * again. */
  const rebuild = async (i) => {
    const s = slots[i];
    const union = [];
    const members = [...s.subs.values()];
    for (const [n, sub] of members.entries()) {
      const held = union.length; /* what the earlier runs take, before this one */
      sub.map = {};
      for (const f of sub.fields) {
        const sig = signature(f);
        let idx = union.findIndex((u) => u.sig === sig);
        if (idx < 0) {
          if (union.length >= MAX_FIELDS) {
            const root = kind === "tcx" ? (i ? "udp" : "tcp") : kind;
            const need = new Set(sub.fields.map(signature)).size;
            throw new Error(n === members.length - 1 ? `the ${root} VM runs ${MAX_FIELDS} fields: ${held} are held by other runs and this query needs ${need}; stop one, or select fewer` : `the ${root} VM runs ${MAX_FIELDS} fields and the running queries need more; stop one`);
          }
          union.push({ sig, field: { ...f, name: `u${union.length}` } });
          idx = union.length - 1;
        }
        sub.map[f.name] = idx;
      }
    }
    /* quiesce, write, arm */
    const was = s.union;
    s.union = [];
    await data.patch({ nfields: slots.map((x) => x.union.length) });
    const base = i * MAX_FIELDS;
    for (let k = 0; k < MAX_FIELDS; k++) await programs.update(base + k, k < union.length ? program(union[k].field) : EMPTY_PROGRAM);
    /* the shared filters: focus only when every subscriber narrows; data only when all want it; the smallest gap */
    const allPorts = [...slots.values()].flatMap((x) => [...x.subs.values()]);
    const focusOn = allPorts.length > 0 && allPorts.every((sub) => sub.ports.length);
    const want = new Set(focusOn ? allPorts.flatMap((sub) => sub.ports) : []);
    for (const port of want) if (!armedPorts.has(port)) await focused.update(port, 1);
    for (const port of [...armedPorts]) if (!want.has(port)) await focused.delete(port).catch(() => {});
    armedPorts = want;
    const subsAll = allPorts;
    const dataOnly = subsAll.length > 0 && subsAll.every((sub) => sub.data);
    const every = subsAll.length ? Math.min(...subsAll.map((sub) => sub.every || 0)) : 0;
    generation = (generation + 1) >>> 0 || 1;
    s.gen = generation;
    s.union = union;
    const patch = {
      gen: slots.map((x) => x.gen),
      focus: want.size ? 1 : 0,
      data_only: dataOnly ? 1 : 0,
      min_gap_ns: BigInt(Math.max(0, Math.round(every * 1e6))),
      nfields: slots.map((x) => x.union.length),
    };
    if (kind === "https") {
      const pids = subsAll.map((sub) => sub.pid).filter(Boolean);
      patch.focus_pid = pids.length && pids.every((p) => p === pids[0]) && pids.length === subsAll.length ? pids[0] : 0;
    }
    if (kind === "xdp") {
      const protos = subsAll.map((sub) => sub.proto);
      patch.proto_filter = protos.length && protos.every((p) => p && p === protos[0]) ? (protos[0] === "tcp" ? 6 : 17) : 0;
    }
    await data.patch(patch);
    return was;
  };
  let armedPorts = new Set();

  const subscription = await new RingBuf(control, "events").subscribe(
    (wrapped) => {
      try {
        const e = wrapped?.walk_event ?? wrapped;
        const s = slots[kind === "tcx" ? (Number(e.root) === ROOT_ID.udp ? 1 : 0) : 0];
        if (!s.union.length || !s.subs.size) return;
        if (Number(e.gen ?? 0) !== s.gen) return;
        const row = decodeEvent(wrapped, s.union.map((u) => u.field));
        for (const sub of s.subs.values()) {
          if (sub.ports.length && !sub.ports.includes(row.sport) && !sub.ports.includes(row.dport)) continue;
          if (sub.data && row.len === 0) continue;
          if (sub.pid && row.pid !== sub.pid) continue;
          if (sub.proto && row.proto !== (sub.proto === "tcp" ? 6 : 17)) continue;
          if (sub.ifindex && !sub.ifindex.has(row.ifindex)) continue;
          if (sub.every && row.at - sub.last < sub.every) continue;
          sub.last = row.at;
          const values = {};
          const raw = {};
          for (const [name, idx] of Object.entries(sub.map)) {
            values[name] = row.values[`u${idx}`] ?? null;
            if (row.raw?.[`u${idx}`] != null) raw[name] = row.raw[`u${idx}`];
          }
          sub.sink({ ...row, values, raw });
        }
      } catch (error) {
        onError?.(error);
      }
    },
    (error) => onError?.(error),
  );

  return {
    control,
    kind,
    attached,
    /**
     * Run `fields` (from compileFields) on `slot` until `limit` rows or
     * `ms` elapsed or `stop` fires — alongside whatever else is running
     * on the slot. Resolves to the rows, oldest first (the last `keep`
     * when unbounded). `onRow` sees each row as it lands.
     */
    capture(slot, fields, { limit = 50, ms = 2000, every = 0, ports = [], data: dataOnly = false, pid, proto, iface, onRow, stop, keep = 1000 } = {}) {
      const s = slots[slot];
      const id = nextSub++;
      const rows = [];
      let done;
      const finished = new Promise((r) => (done = r));
      const sub = {
        id,
        fields,
        ports: ports.map(Number),
        data: Boolean(dataOnly),
        every: Number(every) || 0,
        pid: pid ? Number(pid) : 0,
        proto: proto ?? null,
        ifindex: null, /* a set once `iface` is resolved; the object is on every interface */
        map: {},
        last: 0,
        sink: (row) => {
          rows.push(row);
          if (rows.length > keep) rows.shift();
          onRow?.(row);
          if (rows.length >= limit) done();
        },
      };
      return (async () => {
        if (stop?.aborted) return [];
        if (iface?.length) {
          const known = await interfaces();
          const found = iface.map((w) => known.find((i) => i.name === String(w) || i.index === Number(w))?.index);
          const missing = iface.filter((w, i) => !found[i]);
          if (missing.length) throw new Error(`no interface ${missing.map(String).join(", ")}; have ${known.map((i) => i.name).join(", ")}`);
          sub.ifindex = new Set(found);
        }
        s.subs.set(id, sub);
        try {
          await serial(() => rebuild(slot));
        } catch (error) {
          s.subs.delete(id);
          await serial(() => rebuild(slot)).catch(() => {});
          throw error;
        }
        stop?.on(done);
        const timer = Number.isFinite(ms) ? setTimeout(done, ms) : null;
        try {
          await finished;
        } finally {
          if (timer) clearTimeout(timer);
          s.subs.delete(id);
          await serial(() => rebuild(slot)).catch((error) => onError?.(error));
        }
        return rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
      })();
    },
    /** How many fields each slot has free. */
    free() {
      return slots.map((x) => MAX_FIELDS - x.union.length);
    },
    async stats() {
      const live = (await data.read()) ?? {};
      const n = (k) => Number(live[k] ?? 0);
      return { seen: n("seen"), parsed: n("parsed"), matched: n("matched"), emitted: n("emitted"), ringFull: n("ring_full"), nfields: live.nfields, runs: slots.map((x) => x.subs.size) };
    },
    async stop() {
      await subscription.unsubscribe?.();
      await control.stop();
    },
  };
}
