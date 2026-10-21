/* The walk VM's shape, as bpf/include/event.h defines it: limits, the
 * register file, op codes, and the map value a field program is
 * written as. Pure — shared by the compilers, the decoder and the
 * loader, and the one place the C side is mirrored. Keep in step. */

export const MAX_SLOTS = 2;
export const MAX_FIELDS = 8;
export const MAX_STEP = 8; /* ops per pre[] / body[] section */
export const MAX_ITERS = 2;
export const ENTRY_CAP = 4096; /* bytes one entry may hold; a READ takes at most ENTRY_CAP - 1 */
export const EDATA = 8192; /* bytes of entries per event, packed */
export const MAX_READ = ENTRY_CAP - 1;
export const NREGS = 8;
export const NSCRATCH = 4;

/* The register file every root fills what it can of. */
export const REG = { SK: 0, SKB: 1, FRAME: 2, L3: 3, L4: 4, PAYLOAD: 5, END: 6, CTX: 7 };
export const REG_NAMES = Object.fromEntries(Object.entries(REG).map(([k, v]) => [v, k.toLowerCase()]));

export const ROOT_ID = { xdp: 0, tcp: 1, udp: 2, https: 3 };
export const ROOT_NAMES = Object.fromEntries(Object.entries(ROOT_ID).map(([k, v]) => [v, k]));
export const HOOK = { RX: 0, TX: 1 };

export const WOP = {
  END: 0, BASE: 1, OFF: 2, DEREF: 3, READ: 4, STR: 5, VAL: 6, LOADN: 7, EQ: 8, SKIPZ: 9, SKIPNZ: 10,
  BACK: 11, STORE: 12, LOAD: 13, ADD: 14, SUB: 15, LT: 16, GT: 17, AND: 18, SHR: 19, SKB: 20,
};
const NAMES = Object.fromEntries(Object.entries(WOP).map(([k, v]) => [v, k.toLowerCase()]));

export const op = (code, arg = 0) => ({ code, arg: arg >>> 0 });

/** One op as text, for a program listing: `off 552`, `deref`, `read 4`, `base l4`. */
export const opText = ({ code, arg }) => {
  const name = NAMES[code] ?? String(code);
  if (code === WOP.BASE) return `base ${REG_NAMES[arg] ?? arg}`;
  return arg ? `${name} ${arg}` : name;
};

/** A whole program as one line. */
export const listing = (ops) => ops.map(opText).join("; ");

const pad = (ops) => {
  const out = ops.slice(0, MAX_STEP).map((x) => ({ code: x.code | 0, arg: x.arg >>> 0 }));
  while (out.length < MAX_STEP) out.push({ code: 0, arg: 0 });
  return out;
};

/** A compiled field as the `programs` map value. */
export const program = (f) => ({
  n_pre: Math.min(f.pre.length, MAX_STEP),
  pre: pad(f.pre),
  next_off: (f.nextOff ?? 0) >>> 0,
  max_iters: Math.min(f.maxIters || 1, MAX_ITERS),
  n_body: Math.min(f.body.length, MAX_STEP),
  body: pad(f.body),
});

/** An empty program: the map value for a slot that is not in use. */
export const EMPTY_PROGRAM = program({ pre: [], body: [] });
