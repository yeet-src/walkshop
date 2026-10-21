/* The gate: every page waits on the host's account. The daemon answers
 * the agent as the account it was logged in as, and after a restart or
 * a logout it has none; rather than let each page fail in its own way,
 * the layout shows one login screen until there is one. Runs in the
 * isolate, so it asks auth.js directly and polls while logged out. */
import { createSignal, onCleanup, Show } from "yeetkit";

import { authStatus, onAuth, startLogin } from "./auth.js";

export default function Gate(props) {
  const [auth, setAuth] = createSignal(null); /* null: not yet asked */
  const [busy, setBusy] = createSignal(false);
  const check = async () => {
    try {
      setAuth(await authStatus());
    } catch (e) {
      setAuth({ ok: false, error: String(e?.message ?? e), login: null });
    }
  };
  check();
  /* The moment a login lands, auth.js says so; the poll is the fallback
   * (a login claimed through another page, or `yeet login` on the host). */
  const off = onAuth((state) => setAuth(state));
  const timer = setInterval(() => (auth()?.ok ? Math.random() < 0.2 && check() : check()), 2000);
  onCleanup(() => {
    off();
    clearInterval(timer);
  });

  const logIn = async () => {
    setBusy(true);
    try {
      setAuth(await startLogin());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={auth()?.ok} fallback={
      <main class="min-h-screen flex items-center justify-center px-4" data-gate={auth() === null ? "checking" : "out"}>
        <Show when={auth() !== null} fallback={<p class="text-dim">checking the host's account…</p>}>
          <section class="space-y-4 max-w-prose">
            <h1 class="text-yellow">walkshop · this host is not logged in</h1>
            <p class="text-dim">The daemon answers as the account it was logged in as, and it has none right now. Log in and this page continues on its own.</p>
            <Show when={auth()?.login?.url} fallback={
              <p>
                <button class="text-blue hover:underline" onClick={logIn} disabled={busy()} data-login>
                  {busy() ? "asking the daemon for a code…" : "[log in]"}
                </button>
                <span class="text-dim"> · or </span>
                <code>yeet login</code>
                <span class="text-dim"> on the host</span>
              </p>
            }>
              <p>
                <a class="text-blue underline hover:text-fg" href={auth().login.url} target="_blank" rel="noopener" data-login>{auth().login.url}</a>
                <span class="text-dim"> · waiting…</span>
              </p>
            </Show>
            <Show when={auth()?.error}>
              <p class="text-red text-xs">{auth().error}</p>
            </Show>
          </section>
        </Show>
      </main>
    }>
      {props.children}
    </Show>
  );
}
