/* Home: what is attached, and the roots. Runs in the isolate and
 * reads the registry as a function call. */
import { Link, createSignal, onCleanup } from "yeetkit";

import { probes } from "@/lib/query.js";
import { ROOTS } from "@/lib/roots.js";

export default function Home() {
  const [live, setLive] = createSignal({ attached: [], errors: [] });
  const tick = async () => {
    try {
      setLive(await probes());
    } catch {
      /* the header stops moving; the page stays */
    }
  };
  tick();
  const timer = setInterval(tick, 2000);
  onCleanup(() => clearInterval(timer));

  return (
    <section class="space-y-6">
      <h1 class="comment">a once-verified BPF interpreter, queried in GraphQL</h1>
      <p class="max-w-prose text-dim">
        Four roots, one VM. A query names struct members; the host resolves them through this kernel's BTF into the ops the VM runs, patches them into a map, and the kernel answers. Nothing is recompiled.
        Read the <Link href="/docs" class="text-blue hover:underline">docs</Link> for how to ask — an agent gets the same text from <code>GET /</code> or <code>/api</code> — or open <Link href="/query" class="text-blue hover:underline">query</Link>.
      </p>

      <table class="w-full text-left">
        <thead class="text-dim">
          <tr>
            <th class="pr-4 font-normal">root</th>
            <th class="pr-4 font-normal">object</th>
            <th class="font-normal">hook</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(ROOTS).map((r) => (
            <tr>
              <td class="pr-4 text-yellow">{r.name}</td>
              <td class="pr-4">{r.object}</td>
              <td class="text-dim">{r.hook}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 class="comment">attached now</h2>
      <table class="w-full text-left">
        <thead class="text-dim">
          <tr>
            <th class="pr-4 font-normal">object</th>
            <th class="pr-4 font-normal">users</th>
            <th class="pr-4 font-normal">seen</th>
            <th class="pr-4 font-normal">matched</th>
            <th class="pr-4 font-normal">emitted</th>
            <th class="font-normal">ring full</th>
          </tr>
        </thead>
        <tbody>
          {() =>
            live().attached.length ? (
              live().attached.map((a) => (
                <tr>
                  <td class="pr-4 text-green">{a.key}</td>
                  <td class="pr-4">
                    {a.users}
                    {a.users === 0 && a.until ? <span class="text-dim"> · detaching in {Math.max(0, Math.ceil((a.until - Date.now()) / 1000))}s</span> : null}
                  </td>
                  <td class="pr-4">{a.stats?.seen ?? "–"}</td>
                  <td class="pr-4">{a.stats?.matched ?? "–"}</td>
                  <td class="pr-4">{a.stats?.emitted ?? "–"}</td>
                  <td>{a.stats?.ringFull ?? "–"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td class="text-dim" colspan="6">
                  nothing — a query attaches what it needs and lets go a minute after the last one
                </td>
              </tr>
            )
          }
        </tbody>
      </table>
      {() =>
        live().errors.length ? (
          <ul class="text-red">
            {live().errors.slice(0, 5).map((e) => (
              <li>{e.message}</li>
            ))}
          </ul>
        ) : null
      }
    </section>
  );
}
