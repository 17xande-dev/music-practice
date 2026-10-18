// Record ids, shared by every record type (a leaf module: the record files
// cannot import progress_store.ts, which imports them).

const utf8 = new TextEncoder();

/** An id the server will take: 1-64 bytes of UTF-8 (it counts bytes, not UTF-16 units). */
export const validId = (id: unknown): id is string => {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false; // units <= bytes
  return utf8.encode(id).length <= 64;
};
