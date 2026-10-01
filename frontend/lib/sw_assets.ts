// What the service worker precaches from a page (see frontend/sw.ts), apart
// so it can be tested: the worker itself must have no exports.

/** Asset URLs a page references: anything under /static/ in an attribute. */
export function assetUrls(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/["'](\/static\/[^"'\s]+)["']/g)) {
    out.add(m[1].replaceAll("&amp;", "&"));
  }
  return [...out];
}
