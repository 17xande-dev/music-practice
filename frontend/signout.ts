// Loaded by the signed-out page only. Signing out ends the session on the
// server, but this browser's sync state (which account it syncs with, its
// cursor and queue) lives in localStorage, where the next person to sit here
// would find it. Clear it; the local history itself stays.

import { ProgressStore } from "./lib/progress_store.ts";

try {
  ProgressStore.fromWindow().clearSyncState();
} catch {
  // Storage refused: nothing to clear, and sync cannot run either.
}
