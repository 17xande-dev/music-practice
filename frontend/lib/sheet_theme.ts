// A light or dark music sheet, independent of the site's theme: some
// people read notation more easily black on white even in dark mode, or
// the other way round. The sheets draw in currentColor, so this is only an
// attribute that the stylesheet styles; nothing is redrawn.
//
// "auto" follows the site. A choice that matches the site's theme is
// stored as "auto", so the sheet keeps following the site after that.

import type { ProgressStore } from "./progress_store.ts";
import { renderSwitch, siteTheme, THEME_EVENT } from "./site_theme.ts";

export type SheetTheme = "auto" | "light" | "dark";

/** The theme the sheet actually shows. */
export function effectiveTheme(choice: SheetTheme, siteDark: boolean): "light" | "dark" {
  return choice === "auto" ? (siteDark ? "dark" : "light") : choice;
}

/** What the toggle stores: the other theme, or "auto" if that's the site's. */
export function toggled(choice: SheetTheme, siteDark: boolean): SheetTheme {
  const next = effectiveTheme(choice, siteDark) === "dark" ? "light" : "dark";
  return next === (siteDark ? "dark" : "light") ? "auto" : next;
}

/** Wire a toggle button to some sheets, remembering the choice in the store. */
export function sheetThemeToggle(
  button: HTMLButtonElement,
  sheets: HTMLElement[],
  store: ProgressStore,
) {
  let choice: SheetTheme = store.settings().sheetTheme ?? "auto";
  const siteDark = () => siteTheme() === "dark";
  const apply = () => {
    for (const s of sheets) {
      if (choice === "auto") delete s.dataset.sheet;
      else s.dataset.sheet = choice;
    }
    renderSwitch(button, effectiveTheme(choice, siteDark()) === "dark", "the music sheet");
  };
  button.addEventListener("click", () => {
    choice = toggled(choice, siteDark());
    store.saveSettings({ sheetTheme: choice });
    apply();
  });
  document.addEventListener(THEME_EVENT, apply);
  apply();
}
