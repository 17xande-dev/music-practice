import { assert, assertEquals } from "@std/assert";
import {
  type CommandSpec,
  filterCommands,
  formatShortcut,
  type KeyLike,
  matches,
  normalise,
  parseShortcut,
  validateCommands,
} from "./commands.ts";

const ev = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

Deno.test("shortcuts parse into ordered modifiers and a key", () => {
  assertEquals(parseShortcut("Alt+Mod+KeyF"), { modifiers: ["Mod", "Alt"], key: "KeyF" });
  assertEquals(parseShortcut("Space"), { modifiers: [], key: "Space" });
  for (const bad of ["", "Mod+", "Mod+Mod+K", "Alt", "Mod + K", "Hyper+K"]) {
    assertEquals(parseShortcut(bad), null, bad);
  }
  assertEquals(normalise("Shift+Mod+K"), normalise("Mod+Shift+K"));
});

Deno.test("matching: Mod is Cmd on Apple and Ctrl elsewhere, exactly", () => {
  assert(matches("Mod+K", ev("k", "KeyK", { ctrlKey: true }), false));
  assert(!matches("Mod+K", ev("k", "KeyK", { ctrlKey: true }), true));
  assert(matches("Mod+K", ev("k", "KeyK", { metaKey: true }), true));
  assert(!matches("Mod+K", ev("k", "KeyK", { ctrlKey: true, shiftKey: true }), false));
  assert(!matches("R", ev("r", "KeyR", { ctrlKey: true }), false)); // Ctrl+R is reload
});

Deno.test("matching: chords use the physical key, so Option letters work on a Mac", () => {
  assert(matches("Alt+KeyF", ev("ƒ", "KeyF", { altKey: true }), true));
  assert(matches("Alt+Digit1", ev("¡", "Digit1", { altKey: true }), true));
  assert(matches("ArrowLeft", ev("ArrowLeft", "ArrowLeft"), false));
  assert(matches("Space", ev(" ", "Space"), false));
  // "?" is Shift+/ on most layouts; it still matches.
  assert(matches("?", ev("?", "Slash", { shiftKey: true }), false));
});

Deno.test("display per platform", () => {
  assertEquals(formatShortcut("Mod+K", { apple: true }), "⌘K");
  assertEquals(formatShortcut("Mod+K", { apple: false }), "Ctrl+K");
  assertEquals(formatShortcut("Alt+KeyF", { apple: true }), "⌥F");
  assertEquals(formatShortcut("Alt+Equal", { apple: false }), "Alt+=");
  assertEquals(formatShortcut("ArrowRight", { apple: false }), "→");
});

const specs: CommandSpec[] = [
  { id: "play", label: "Play / pause", group: "Playback", shortcut: "Space" },
  { id: "next", label: "Next measure", group: "Navigate", shortcut: "ArrowRight" },
  { id: "big", label: "Big screen", group: "View", keywords: ["fullscreen"] },
  { id: "loop", label: "Repeat the selection", group: "Practice", keywords: ["loop"] },
];

Deno.test("filtering ranks prefix over word over keyword, keeps ties stable", () => {
  assertEquals(filterCommands(specs, "").map((c) => c.id), ["play", "next", "big", "loop"]);
  assertEquals(filterCommands(specs, "mea").map((c) => c.id), ["next"]);
  assertEquals(filterCommands(specs, "full").map((c) => c.id), ["big"]);
  assertEquals(filterCommands(specs, "loop").map((c) => c.id), ["loop"]);
  assertEquals(filterCommands(specs, "(").map((c) => c.id), []); // regex chars are literal
});

Deno.test("validation catches clashes, bad keys and keys that play notes", () => {
  assertEquals(validateCommands(specs), []);
  const bad: CommandSpec[] = [
    { id: "a", label: "A", group: "View", shortcut: "Mod+K" },
    { id: "b", label: "B", group: "View", shortcut: "Mod+K" },
    { id: "a", label: "C", group: "View", shortcut: "Mod++" },
    { id: "d", label: "D", group: "View", shortcut: "F" }, // F plays a note
  ];
  const p = validateCommands(bad);
  assert(p.some((x) => x.includes("share")));
  assert(p.some((x) => x.includes("duplicate id")));
  assert(p.some((x) => x.includes("unparseable")));
  assert(p.some((x) => x.includes("note")));
});
