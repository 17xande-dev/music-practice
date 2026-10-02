// Commands: everything the keyboard shortcuts and the command palette can do,
// as data. Pure (no DOM), so parsing, matching, display and filtering are
// tested directly. Modelled on teleprompter's commands.ts, with its own key
// matcher instead of tinykeys.
//
// Shortcut syntax: "Space", "R", "ArrowLeft", "Mod+K", "Alt+KeyF". Mod is
// Cmd on Apple platforms and Ctrl elsewhere. Letters and digits in chords
// are physical keys (KeyF, Digit1), matched on event.code: Option changes
// event.key on a Mac (Option+F is "ƒ"). A bare key may not be one the
// computer-keyboard fallback plays as a note (qwerty.ts), and validation
// enforces that.

import { pcForCode } from "./qwerty.ts";

export const COMMAND_GROUPS = ["Playback", "Navigate", "View", "Practice", "Site"] as const;
export type CommandGroup = typeof COMMAND_GROUPS[number];

export interface CommandSpec {
  id: string;
  label: string;
  group: CommandGroup;
  /** Absent: palette only. */
  shortcut?: string;
  keywords?: string[];
  /** Fire again while the key is held (measure skipping), not for toggles. */
  repeatable?: boolean;
}

export interface Command extends CommandSpec {
  run(): void | Promise<void>;
  /** False greys it out in the palette, and its shortcut does nothing. */
  enabled?(): boolean;
}

type Modifier = "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta";
const MODIFIERS: Modifier[] = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];

export interface Shortcut {
  modifiers: Modifier[];
  key: string;
}

export function parseShortcut(s: string): Shortcut | null {
  if (!s || /\s/.test(s)) return null;
  // "+" alone, or as the last key ("Mod++"), isn't supported; "Equal" is.
  const parts = s.split("+");
  if (parts.some((p) => !p)) return null;
  const key = parts.pop()!;
  if ((MODIFIERS as string[]).includes(key)) return null;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    if (!(MODIFIERS as string[]).includes(p) || mods.has(p as Modifier)) return null;
    mods.add(p as Modifier);
  }
  return { modifiers: MODIFIERS.filter((m) => mods.has(m)), key };
}

/** A canonical form for comparing bindings. */
export function normalise(s: string): string | null {
  const p = parseShortcut(s);
  return p && [...p.modifiers, p.key].join("+");
}

/** The parts of a KeyboardEvent the matcher reads. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const PHYSICAL = /^(Key[A-Z]|Digit\d|Equal|Minus|BracketLeft|BracketRight|Slash|Backquote)$/;

export function matches(shortcut: string, e: KeyLike, apple: boolean): boolean {
  const p = parseShortcut(shortcut);
  if (!p) return false;
  const want = new Set(p.modifiers);
  const ctrl = want.has("Ctrl") || (want.has("Mod") && !apple);
  const meta = want.has("Meta") || (want.has("Mod") && apple);
  // "?" is typed with Shift on most layouts, so a bare symbol key ignores
  // Shift; everything else matches its modifiers exactly.
  const symbol = p.key.length === 1 && !/[a-z0-9]/i.test(p.key);
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== want.has("Alt")) return false;
  if (!symbol && e.shiftKey !== want.has("Shift")) return false;
  if (PHYSICAL.test(p.key)) return e.code === p.key;
  if (p.key === "Space") return e.code === "Space" || e.key === " ";
  return e.key.toLowerCase() === p.key.toLowerCase();
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Equal: "=",
  Minus: "−",
  Slash: "/",
  Space: "Space",
};

export function formatShortcut(s: string, { apple }: { apple: boolean }): string {
  const p = parseShortcut(s);
  if (!p) return s;
  const key = KEY_LABELS[p.key] ?? p.key.replace(/^(Key|Digit)/, "");
  const sym: Record<Modifier, string> = apple
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
    : { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta" };
  const mods = p.modifiers.map((m) => sym[m]);
  return apple ? [...mods, key].join("") : [...mods, key].join("+");
}

export function isApple(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Commands matching a palette query, best first: the label equal, then
 * starting with it, then a word in it starting with it, then containing it,
 * then a keyword or the group containing it. Ties keep table order, so the
 * list doesn't jump about while typing.
 */
export function filterCommands<T extends CommandSpec>(cmds: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const order = (c: T) => COMMAND_GROUPS.indexOf(c.group);
  const byGroup = cmds.map((c, i) => ({ c, i })).sort((a, b) =>
    order(a.c) - order(b.c) || a.i - b.i
  );
  if (!q) return byGroup.map((x) => x.c);
  const word = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const score = (c: T) => {
    const l = c.label.toLowerCase();
    if (l === q) return 100;
    if (l.startsWith(q)) return 80;
    if (word.test(l)) return 60;
    if (l.includes(q)) return 40;
    if (c.keywords?.some((k) => k.toLowerCase().includes(q))) return 20;
    if (c.group.toLowerCase().includes(q)) return 10;
    return 0;
  };
  return byGroup.map((x, rank) => ({ ...x, rank, s: score(x.c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.rank - b.rank)
    .map((x) => x.c);
}

/** Everything wrong with a command table; empty when it's sound. */
export function validateCommands(specs: readonly CommandSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const binds = new Map<string, string>();
  for (const s of specs) {
    if (ids.has(s.id)) problems.push(`duplicate id ${s.id}`);
    ids.add(s.id);
    if (!(COMMAND_GROUPS as readonly string[]).includes(s.group)) {
      problems.push(`${s.id}: unknown group ${s.group}`);
    }
    if (!s.shortcut) continue;
    const n = normalise(s.shortcut);
    if (!n) {
      problems.push(`${s.id}: unparseable shortcut ${s.shortcut}`);
      continue;
    }
    const other = binds.get(n);
    if (other) problems.push(`${s.id} and ${other} share ${s.shortcut}`);
    binds.set(n, s.id);
    const p = parseShortcut(s.shortcut)!;
    if (!p.modifiers.length) {
      const code = /^[A-Z]$/.test(p.key) ? `Key${p.key}` : p.key;
      if (pcForCode(code) !== undefined) {
        problems.push(`${s.id}: ${s.shortcut} is a computer-keyboard note`);
      }
    }
  }
  return problems;
}

/** The DOM element an event is typed into, which keys must leave alone. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Space would also press a focused button, link or summary. */
export function isActivatable(el: Element | null): boolean {
  return !!el?.closest?.("button, a[href], summary, [role=button], [role=switch]");
}
