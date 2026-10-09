// The starter pieces served with the site, and their library ids. A starter
// copied into the library is keyed `starter:<slug>`, where the slug is the
// file's basename without ".musicxml", the same id the iPad app uses, so
// history (personal bests, imported sessions) lines up across devices.
//
// Before this, a starter was copied under a random UUID. Those copies are
// recognised by their file name (libraries) or title (exports, which don't
// carry the file name) and moved to the stable id.

export const STARTER_PREFIX = "starter:";

export const STARTERS: readonly { slug: string; titles: readonly string[] }[] = [
  {
    slug: "bach-prelude-in-c",
    titles: ["Prelude in C major, BWV 846 (opening)"],
  },
  { slug: "minuet-in-g", titles: ["Minuet in G major"] },
  { slug: "ode-to-joy", titles: ["Ode to Joy"] },
  { slug: "twinkle-twinkle", titles: ["Twinkle, Twinkle, Little Star"] },
];

export const starterId = (slug: string) => STARTER_PREFIX + slug;

export const isStarterId = (id: string) => id.startsWith(STARTER_PREFIX);

/** The slug of a starter's file ("ode-to-joy.musicxml"), or null for any other file. */
export function starterSlugForFile(fileName: string): string | null {
  const slug = fileName.replace(/\.musicxml$/, "");
  return STARTERS.some((s) => s.slug === slug) ? slug : null;
}

/** The slug of the starter with this title, or null. */
export function starterSlugForTitle(title: string): string | null {
  const t = title.trim().toLowerCase();
  return STARTERS.find((s) => s.titles.some((x) => x.toLowerCase() === t))?.slug ?? null;
}

interface LibraryEntry {
  id: string;
  fileName: string;
  added: number;
}

export interface StarterMigration {
  /** Old id → starter id, for every copy that moves (including duplicates that merge). */
  remap: Map<string, string>;
  /** The copy kept for each starter that has to be rewritten: its old id (the one to rename). */
  keep: Map<string, string>;
}

/**
 * Which library entries are starter copies under a non-starter id, and where
 * they go. When a starter already has its stable entry, every other copy is
 * merged into it; otherwise the earliest-added copy is renamed and the rest
 * merged into that. Nothing to do (empty maps) once migrated.
 */
export function planStarterMigration(entries: readonly LibraryEntry[]): StarterMigration {
  const remap = new Map<string, string>();
  const keep = new Map<string, string>();
  for (const { slug } of STARTERS) {
    const target = starterId(slug);
    const copies = entries
      .filter((e) =>
        e.id !== target && !isStarterId(e.id) && starterSlugForFile(e.fileName) === slug
      )
      .sort((a, b) => a.added - b.added);
    if (!copies.length) continue;
    for (const c of copies) remap.set(c.id, target);
    if (!entries.some((e) => e.id === target)) keep.set(target, copies[0].id);
  }
  return { remap, keep };
}
