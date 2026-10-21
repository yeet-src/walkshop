"use yeet";

/* The host's account, for the page. The daemon answers the agent as
 * the account it was logged in as; after a restart it may have none.
 * `yeet.whoami()` says which it is; `login()` from yeet:auth issues a
 * code and a URL to claim it at, and resolves once that happens. The
 * page shows the link; the browser does the rest. */
import { login } from "yeet:auth";

import { push } from "./lane.js";

let flow = null; /* the login in progress: { code, url, at } */

const whoami = async () => {
  try {
    const w = await yeet.whoami();
    return w && w.owner_id ? { ok: true, host: w.host_id, owner: w.owner_id } : { ok: false };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

/** `{ ok, host?, owner?, login? }` — `login` is the code and URL of a flow under way. */
export async function authStatus() {
  const w = await whoami();
  return { ...w, login: flow ? { code: flow.code, url: flow.url, at: flow.at } : null };
}

/**
 * Start a login unless one is under way, and answer with its code and
 * URL as soon as the daemon issues them (within a few seconds). The
 * outcome is pushed on the lane as `{ login: { ok } }` so every open
 * page sees it.
 */
export async function startLogin() {
  const w = await whoami();
  if (w.ok) return { ...w, login: null };
  if (!flow) {
    const f = { code: null, url: null, at: Date.now() };
    let issued;
    const got = new Promise((r) => (issued = r));
    flow = f;
    login({
      onCode: ({ code, url }) => {
        f.code = code;
        f.url = url;
        push({ op: "walkshop-chat", login: { code, url, pending: true } });
        issued();
      },
    })
      .then((who) => {
        if (flow === f) flow = null;
        push({ op: "walkshop-chat", login: { ok: true, host: who?.host_id, owner: who?.owner_id } });
      })
      .catch((e) => {
        if (flow === f) flow = null;
        push({ op: "walkshop-chat", login: { ok: false, error: String(e?.message ?? e) } });
      });
    await Promise.race([got, new Promise((r) => setTimeout(r, 4000))]);
  }
  return { ok: false, login: { code: flow?.code ?? null, url: flow?.url ?? null, at: flow?.at ?? Date.now() } };
}
