/* The frame: a nav line, the buffer, and the mode line fixed along the
 * bottom. Runs in the isolate. */
import { Link } from "yeetkit";

import Gate from "@/lib/Gate.jsx";
import ThemePicker from "@/lib/ThemePicker.jsx";

export default function Layout(props) {
  const routes = [
    ["/", "*walkshop*", true],
    ["/query", "*query*", false],
    ["/chat", "*chat*", false],
    ["/docs", "*docs*", false],
  ];
  return (
    <div class="min-h-screen bg-bg text-fg">
      <Gate>
        {/* pb-10: room for the mode line fixed along the bottom. */}
        <main class="w-full px-4 py-2 pb-10">
          <nav class="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {routes.map(([href, name, end]) => (
              <Link href={href} end={end} class="text-dim hover:text-fg" activeClass="!text-magenta !underline underline-offset-4">
                {name}
              </Link>
            ))}
            <span class="ml-auto text-dim">one VM · three objects · four roots</span>
          </nav>
          {props.children}
        </main>
        <ThemePicker />
      </Gate>
    </div>
  );
}
