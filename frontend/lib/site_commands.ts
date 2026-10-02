// Commands every page has: moving between the pages and the theme. The
// palette adds its own two (open the palette, show the shortcuts).

import type { Command } from "./commands.ts";

const go = (path: string) => () => {
  location.href = path;
};

export function siteCommands(): Command[] {
  return [
    {
      id: "site.scales",
      label: "Go to Scales",
      group: "Site",
      shortcut: "Alt+Digit1",
      run: go("/"),
    },
    {
      id: "site.songs",
      label: "Go to Songs",
      group: "Site",
      shortcut: "Alt+Digit2",
      run: go("/songs"),
    },
    {
      id: "site.progress",
      label: "Go to Progress",
      group: "Site",
      shortcut: "Alt+Digit3",
      keywords: ["history"],
      run: go("/progress"),
    },
    { id: "site.about", label: "About, privacy and credits", group: "Site", run: go("/about") },
    {
      id: "site.theme",
      label: "Switch light / dark theme",
      group: "Site",
      shortcut: "Alt+KeyT",
      keywords: ["dark mode", "light mode"],
      // The header switch owns the theme (theme.ts); this presses it.
      run: () => document.getElementById("site-theme")?.click(),
    },
  ];
}
