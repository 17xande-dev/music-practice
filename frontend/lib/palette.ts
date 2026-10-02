// The command palette and the keyboard-shortcut sheet: one native <dialog>
// (in layout.html) that lists commands, filtered as you type, with their
// keys. Mod+K opens it with every command; ? or Mod+/ opens the shortcut
// sheet (only commands with keys, no search). installCommands() also binds
// every command's shortcut for the page, through one keydown listener.
//
// Rows are built with textContent, never markup, and styled by class:
// nothing here needs the CSP to allow inline content.

import {
  type Command,
  filterCommands,
  formatShortcut,
  isActivatable,
  isApple,
  isTypingTarget,
  matches,
} from "./commands.ts";

type Mode = "all" | "shortcuts";

const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
const APPLE = isApple(nav.userAgentData?.platform ?? navigator.platform ?? "");

/** How a command's key reads on this platform, for titles and the palette. */
export const keyHint = (shortcut: string) => formatShortcut(shortcut, { apple: APPLE });

export function installCommands(commands: Command[]) {
  const dialog = document.getElementById("palette") as HTMLDialogElement | null;
  const input = document.getElementById("palette-input") as HTMLInputElement | null;
  const list = document.getElementById("palette-list");
  const title = document.getElementById("palette-title");
  if (!dialog || !input || !list || !title) return;

  let mode: Mode = "all";
  let shown: Command[] = [];
  let selected = 0;
  let returnFocus: HTMLElement | null = null;

  const enabled = (c: Command) => c.enabled?.() ?? true;

  function render() {
    shown = mode === "shortcuts"
      ? filterCommands(listed.filter((c) => c.shortcut), "")
      : filterCommands(listed, input!.value);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    const rows: HTMLElement[] = [];
    let group = "";
    shown.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        const h = document.createElement("div");
        h.className = "palette-group";
        h.textContent = group;
        h.setAttribute("role", "presentation");
        rows.push(h);
      }
      const row = document.createElement("div");
      row.className = "palette-item";
      row.id = `palette-${i}`;
      row.setAttribute("role", "option");
      row.dataset.index = String(i);
      row.setAttribute("aria-selected", String(i === selected));
      if (!enabled(c)) row.setAttribute("aria-disabled", "true");
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = c.label;
      row.append(label);
      if (c.shortcut) {
        const k = document.createElement("kbd");
        k.className = "palette-keys";
        k.textContent = keyHint(c.shortcut);
        row.append(k);
      }
      rows.push(row);
    });
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matching command";
      rows.push(empty);
    }
    list!.replaceChildren(...rows);
    input!.setAttribute("aria-activedescendant", shown.length ? `palette-${selected}` : "");
    document.getElementById(`palette-${selected}`)?.scrollIntoView({ block: "nearest" });
  }

  function open(m: Mode) {
    if (dialog!.open) dialog!.close();
    mode = m;
    selected = 0;
    input!.value = "";
    input!.hidden = m === "shortcuts";
    title!.textContent = m === "shortcuts" ? "Keyboard shortcuts" : "Commands";
    returnFocus = document.activeElement as HTMLElement | null;
    render();
    dialog!.showModal();
    if (m === "all") input!.focus();
    else list!.focus();
  }

  function runSelected() {
    const c = shown[selected];
    if (!c || !enabled(c)) return;
    dialog!.close();
    void c.run();
  }

  dialog.addEventListener("close", () => {
    returnFocus?.focus?.();
    returnFocus = null;
  });
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  dialog.addEventListener("keydown", (e) => {
    const last = shown.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, selected + 1),
      ArrowUp: Math.max(0, selected - 1),
      Home: 0,
      End: last,
    };
    if (e.key in moves && last >= 0) {
      // Home/End in the search box move the caret, as usual.
      if ((e.key === "Home" || e.key === "End") && e.target === input) return;
      selected = moves[e.key];
    } else if (e.key === "Enter") {
      runSelected();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    render();
  });
  list.addEventListener("pointermove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (row && Number(row.dataset.index) !== selected) {
      selected = Number(row.dataset.index);
      render();
    }
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!row) return;
    selected = Number(row.dataset.index);
    runSelected();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the backdrop
  });

  const shortcutSheet: Command = {
    id: "site.shortcuts",
    label: "Keyboard shortcuts",
    group: "Site",
    shortcut: "?",
    keywords: ["help", "keys"],
    run: () => open("shortcuts"),
  };
  // What the palette lists, and what the keys bind (one more: Mod+/ also
  // opens the sheet, without a second row for it).
  const listed: Command[] = [
    ...commands,
    {
      id: "site.palette",
      label: "Command palette",
      group: "Site",
      shortcut: "Mod+K",
      run: () => open("all"),
    },
    shortcutSheet,
  ];
  const bound: Command[] = [...listed, {
    ...shortcutSheet,
    id: "site.shortcuts-mod",
    shortcut: "Mod+Slash",
  }];
  document.getElementById("palette-open")?.addEventListener("click", () => open("all"));

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || dialog.open) return;
    const target = e.target as Element | null;
    if (isTypingTarget(target)) return;
    const hit = bound.find((c) => c.shortcut && matches(c.shortcut, e, APPLE));
    if (!hit) return;
    if (e.repeat && !hit.repeatable) return;
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (bare && hit.shortcut === "Space" && isActivatable(target)) return;
    if (!enabled(hit)) return;
    e.preventDefault();
    void hit.run();
  });
}
