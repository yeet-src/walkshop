"use client";

/* The mode line: a bar along the bottom, in segments, carrying the
 * theme choice — the same one httpscope has.
 *
 * An island, because the choice is the viewer's: the isolate renders
 * one view for everyone, and a theme set there would change every tab.
 * Hovering a name previews it on the whole page; leaving the menu puts
 * the chosen one back; a click keeps it. The attribute, the memory and
 * the charts' retheming are lib/theme.js's. */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { apply, current, THEMES } from "./theme.js";

export default function ThemePicker() {
  const [chosen, setChosen] = createSignal(current());
  const [preview, setPreview] = createSignal(null);
  const [open, setOpen] = createSignal(false);
  /* Escape closes and reverts; a click elsewhere does the same. */
  const onKey = (e) => e.key === "Escape" && close();
  const onClick = (e) => {
    if (open() && !e.target.closest?.("[data-theme-menu]")) close();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onClick);
    clearTimeout(pending);
  });
  const close = () => {
    clearTimeout(pending);
    setOpen(false);
    setPreview(null);
    if (current() !== chosen()) apply(chosen(), false);
  };
  const choose = (name) => {
    setChosen(name);
    apply(name);
    close();
  };
  /* A preview waits a beat, so running the pointer down the list does
   * not flash every palette on the way to one. */
  let pending = null;
  const hover = (name) => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      setPreview(name);
      apply(name, false);
    }, 350);
  };
  const unhover = () => {
    clearTimeout(pending);
    setPreview(null);
    if (current() !== chosen()) apply(chosen(), false);
  };
  const shown = () => preview() ?? chosen();
  const label = (k) => THEMES.find(([key]) => key === k)?.[1] ?? k;

  /* z-[100]: above the chat's dashboard, corner panel and prompt bar (z-40/50). */
  return (
    <div class="fixed inset-x-0 bottom-0 z-[100] flex items-stretch border-t border-rule bg-mode text-dim" data-theme-menu data-foot>
      {/* The theme segment is the menu's handle. */}
      <span class="relative">
        <button class={`px-3 py-0.5 hover:text-fg ${open() ? "bg-rule text-fg" : ""}`} onClick={() => (open() ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open()}>
          theme <span class="text-fg">{label(chosen())}</span> {open() ? "▾" : "▴"}
        </button>
        <Show when={open()}>
          {/* The menu, above the bar: hovering a row previews it on the
              page, leaving the menu reverts, a click keeps. */}
          <div class="next-menu absolute bottom-full left-0 mb-1 min-w-52" role="menu" onMouseLeave={unhover}>
            <div class="next-title">Theme</div>
            <For each={THEMES}>
              {([k, name]) => (
                <button
                  class={`next-item ${shown() === k ? "next-item--lit" : ""}`}
                  role="menuitemradio"
                  aria-checked={chosen() === k}
                  onMouseEnter={() => hover(k)}
                  onFocus={() => hover(k)}
                  onClick={() => choose(k)}
                >
                  <span class="w-3">{chosen() === k ? "✓" : ""}</span>
                  <span class="flex-1">{name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </span>
      <span class="ml-auto shrink-0 px-3 py-0.5">{preview() && preview() !== chosen() ? `previewing ${label(preview())} · click to keep` : ""}</span>
    </div>
  );
}
