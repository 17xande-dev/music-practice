// Loaded as a classic, blocking script in <head> of every page (the About
// page has no other script), so a remembered theme is applied before the
// page paints, with no flash of the other theme. It also wires the header's
// sun/moon switch. Must have no exports: it isn't a module.

import {
  applyTheme,
  renderSwitch,
  savedTheme,
  SETTINGS_KEY,
  siteTheme,
  THEME_EVENT,
} from "./lib/site_theme.ts";

applyTheme(savedTheme());

function remember(theme: "light" | "dark") {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, theme }));
  } catch {
    // Storage blocked: the pick lasts for this page only.
  }
}

addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("site-theme");
  if (!button) return;
  const show = () => renderSwitch(button, siteTheme() === "dark", "the site");
  button.addEventListener("click", () => {
    const next = siteTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    remember(next);
    show();
    document.dispatchEvent(new Event(THEME_EVENT));
  });
  // Following the system: its change is a theme change too.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    show();
    document.dispatchEvent(new Event(THEME_EVENT));
  });
  show();
});
