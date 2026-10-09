// Offers to delete saved data that can't be read. Pages already skip bad
// records and keys in memory, so they work either way; this only asks whether
// to remove them for good. "Not now" (or Esc) leaves storage untouched, and
// the question comes back on the next load while the data is still bad.

import type { ProgressStore, Scan } from "./progress_store.ts";
import type { SongLibrary } from "./song_library.ts";

export interface Problem {
  label: string;
  detail: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function describeScan(s: Scan): Problem {
  const what = s.key === "mp.v1.settings" ? "setting" : "record";
  return {
    label: s.label,
    detail: s.corrupt
      ? "can't be read at all and will be reset"
      : `${plural(s.dropped, what)} can't be read and will be removed`,
  };
}

/** Everything unreadable in localStorage and the song library; never throws. */
export async function findProblems(
  store: ProgressStore,
  library: SongLibrary | null = null,
): Promise<{ problems: Problem[]; remove: () => Promise<void> }> {
  const scans = store.scan();
  const problems = scans.map(describeScan);
  let bad = 0;
  try {
    bad = (await library?.unreadable())?.length ?? 0;
  } catch { /* an unreadable library is reported by its own status */ }
  if (bad) {
    problems.push({
      label: "Song library",
      detail: `${plural(bad, "song")} can't be read and will be removed`,
    });
  }
  for (const p of problems) console.warn(`Unreadable saved data: ${p.label} ${p.detail}`);
  return {
    problems,
    remove: async () => {
      store.repair();
      try {
        if (bad) await library?.removeUnreadable();
      } catch { /* leave it for the next load */ }
    },
  };
}

/** Show the dialog. Resolves when it closes; `remove` runs only on "Delete it". */
export function offerRepair(problems: Problem[], remove: () => Promise<void>): Promise<boolean> {
  if (!problems.length) return Promise.resolve(false);
  const dialog = document.createElement("dialog");
  dialog.className = "repair";
  dialog.setAttribute("aria-labelledby", "repair-title");
  const h = document.createElement("h2");
  h.id = "repair-title";
  h.textContent = "Some saved data couldn't be read";
  const intro = document.createElement("p");
  intro.textContent = "The rest of your history is fine. You can delete just the unreadable parts:";
  const ul = document.createElement("ul");
  for (const p of problems) {
    const li = document.createElement("li");
    li.textContent = `${p.label}: ${p.detail}.`;
    ul.append(li);
  }
  const row = document.createElement("div");
  row.className = "repair-actions";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = "Delete it";
  const later = document.createElement("button");
  later.type = "button";
  later.className = "secondary";
  later.textContent = "Not now";
  row.append(del, later);
  dialog.append(h, intro, ul, row);
  document.body.append(dialog);

  const returnFocus = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    let deleted = false;
    later.addEventListener("click", () => dialog.close());
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await remove();
        deleted = true;
      } finally {
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      returnFocus?.focus?.();
      resolve(deleted);
    });
    dialog.showModal();
    later.focus(); // the safe choice, so Enter never deletes by accident
  });
}

/** Check once on load; if anything is unreadable, ask. Resolves true when data was deleted. */
export async function checkStoredData(
  store: ProgressStore,
  library: SongLibrary | null = null,
): Promise<boolean> {
  try {
    const { problems, remove } = await findProblems(store, library);
    return await offerRepair(problems, remove);
  } catch (e) {
    console.warn("Couldn't check saved data", e);
    return false;
  }
}
