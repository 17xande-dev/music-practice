// The starter pieces served with the site, and their library ids. A starter
// copied into the library is keyed `starter:<slug>`, where the slug is the
// file's basename without ".musicxml", the same id the iPad app uses, so
// history (personal bests, imported sessions) lines up across devices.
//
// Before this, a starter was copied under a random UUID. Those copies are
// deleted on load (their history is not carried over).

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

/** Library entries holding a starter's file under a random id (copies from before starter ids): to delete. */
export function staleStarterIds(entries: readonly { id: string; fileName: string }[]): string[] {
  return entries
    .filter((e) => !isStarterId(e.id) && starterSlugForFile(e.fileName) !== null)
    .map((e) => e.id);
}
