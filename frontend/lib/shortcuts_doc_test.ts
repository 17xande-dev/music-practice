// The README's shortcut table must list every key the pages bind, and each
// page's bindings must be sound together (no clashes, no note keys). The
// command tables live in the page controllers, which need a DOM, so their
// shortcuts are read from the source text.
import { assert, assertEquals } from "@std/assert";
import { type CommandSpec, formatShortcut, validateCommands } from "./commands.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const shortcuts = (src: string) => [...src.matchAll(/shortcut: "([^"]+)"/g)].map((m) => m[1]);

const shared = [
  ...shortcuts(read("frontend/lib/site_commands.ts")),
  ...shortcuts(read("frontend/lib/palette.ts")),
];
const pages = {
  scales: [...shared, ...shortcuts(read("frontend/practice.ts"))],
  songs: [...shared, ...shortcuts(read("frontend/songs.ts"))],
};

Deno.test("each page's shortcuts are sound together", () => {
  for (const [page, keys] of Object.entries(pages)) {
    const specs: CommandSpec[] = keys.map((shortcut, i) => ({
      id: `${page}.${i}`,
      label: shortcut,
      group: "Site",
      shortcut,
    }));
    assertEquals(validateCommands(specs), [], page);
  }
});

Deno.test("the README lists every shortcut", () => {
  const readme = read("README.md");
  const start = readme.indexOf("## Keyboard shortcuts");
  assert(start >= 0, "README has no Keyboard shortcuts section");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 5));
  for (const key of new Set([...pages.scales, ...pages.songs])) {
    if (key === "Mod+Slash") continue; // a second key for the sheet, mentioned with "?"
    const shown = formatShortcut(key, { apple: false });
    assert(section.includes(`\`${shown}\``), `README is missing ${shown} (${key})`);
  }
});
