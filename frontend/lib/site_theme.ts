// The site's light/dark theme. It follows the system until the player picks
// one with the sun/moon switch in the header; the pick is remembered in the
// settings and applied as <html data-theme>, which the stylesheet styles.
// frontend/theme.ts applies it before the page paints, and wires the switch.

export type Theme = "light" | "dark";

/** Fired on document when the site's theme changes, by the switch or the system. */
export const THEME_EVENT = "mp-themechange";
export const SETTINGS_KEY = "mp.v1.settings";

const COLORS: Record<Theme, string> = { light: "#fbf7f1", dark: "#110d08" };

export const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** The theme the site shows now. */
export function siteTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : systemDark() ? "dark" : "light";
}

/** The remembered pick, if any; read straight from storage, which may throw. */
export function savedTheme(): Theme | null {
  try {
    const t = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")?.theme;
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** Show `theme` (or follow the system with null), including the browser's toolbar colour. */
export function applyTheme(theme: Theme | null) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // Each meta carries its media query; a pick overrides both.
    const own = m.media.includes("dark") ? "dark" : "light";
    m.content = COLORS[theme ?? own];
  }
}

/** A sun/moon switch: checked means dark. */
export function renderSwitch(button: HTMLElement, dark: boolean, what: string) {
  button.setAttribute("aria-checked", String(dark));
  button.title = dark ? `Switch ${what} to light` : `Switch ${what} to dark`;
}
