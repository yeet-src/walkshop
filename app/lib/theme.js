/* The page's palette, chosen per browser. The stylesheet carries the
 * default in `@theme` and each alternative as a block that overrides
 * the same variables under `html[data-theme=…]`, so choosing is one
 * attribute on the root; the choice is remembered in localStorage and
 * restored when this bundle loads, which is before the first frame
 * arrives over the socket. Browser side: the mode line's picker and
 * the charts import it; nothing in the isolate does. */

/** `[key, label]`: the attribute value, and the name the menu shows. */
export const THEMES = [
  ["terminal", "terminal"],
  ["paper", "paper"],
  ["solarized-dark", "solarized"],
  ["solarized-light", "solarized light"],
  ["gruvbox-dark", "gruvbox"],
  ["gruvbox-light", "gruvbox light"],
  ["nord", "nord"],
  ["dracula", "dracula"],
  ["tokyo-night", "tokyo night"],
  ["one-light", "one light"],
];
export const DEFAULT = THEMES[0][0];
const KEY = "walkshop.theme";
const known = (name) => THEMES.some(([k]) => k === name);

/* Who wants to hear a change: the picker, and every mounted chart. */
const listeners = new Set();

const root = () => document.documentElement;

/** The theme on the page right now: the root's attribute, or the default. */
export const current = () => root().dataset.theme || DEFAULT;

/**
 * Put a theme on the root and, unless told not to, remember it. Not
 * remembering is how the menu previews: the page takes the colour, the
 * choice stands.
 */
export function apply(name, remember = true) {
  if (!known(name)) name = DEFAULT;
  if (name === DEFAULT) delete root().dataset.theme;
  else root().dataset.theme = name;
  if (remember) {
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* a browser without storage: the choice lasts the page */
    }
  }
  for (const fn of listeners) {
    try {
      fn(name);
    } catch {
      /* a listener's problem */
    }
  }
}

/** Hear every change; answers with the function that stops listening. */
export function onTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* The remembered choice, applied once as the bundle loads. */
if (typeof document !== "undefined") {
  try {
    const v = localStorage.getItem(KEY);
    if (known(v) && v !== current()) apply(v, false);
  } catch {
    /* no storage, no memory */
  }
}

/* The default palette, for a DOM that cannot compute custom
 * properties off a stylesheet (jsdom, in the wire test). */
const FALLBACK = {
  bg: "#000000", mode: "#141414", rule: "#2a2a2a", fg: "#f0f0f0", dim: "#8a8a8a",
  red: "#ff0000", orange: "#ff9500", yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff",
  blue: "#29b6ff", magenta: "#ff00ff", pink: "#ff7eb6", comment: "#00ff00",
};

/** One colour of the palette in force, as the stylesheet has it: `colour("fg")`. */
export function colour(name) {
  let v = "";
  try {
    v = getComputedStyle(root()).getPropertyValue(`--color-${name}`).trim();
  } catch {
    /* not a browser */
  }
  return v || FALLBACK[name] || "";
}
