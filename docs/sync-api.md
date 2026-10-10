# Sync API

How the web app and the iPad app sync practice history through the server. The server side lives in
`internal/handler/api.go` (HTTP) and `internal/history` (storage). Both clients follow the algorithm
at the end of this page.

## Model

- **Local first.** Each device keeps its own history (localStorage on the web, files on the iPad)
  and works offline and signed out. The server is where a signed-in user's devices swap runs.
- **A run is immutable.** One finished scale run, song run or Learn pass, stored as the client's own
  JSON. Runs are never edited, so syncing is a union by `(kind, id)`.
- **Kinds** map to the storage keys both apps already use:

  | kind    | local key            | record type                         |
  | ------- | -------------------- | ----------------------------------- |
  | `scale` | `mp.v1.sessions`     | `Session` (progress_store.ts)       |
  | `song`  | `mp.v1.songSessions` | `SongSession` (lib/song_session.ts) |
  | `learn` | `mp.v1.learn`        | `LearnSession` (lib/learn_log.ts)   |

- **Deletions are tombstones.** Removing a song's history or clearing all history on one device
  sends the removed ids. The server keeps a tombstone, so every other device deletes them too, and a
  device that hasn't heard yet can't resurrect them by pushing them again: a tombstoned id stays
  deleted.
- **The local 2000-run cap is not a deletion.** When a device trims its oldest runs to stay under
  the cap, it sends nothing. The server keeps everything.
- **Cursor.** Every stored run and tombstone gets a new, increasing sequence number. A client keeps
  the highest one it has seen and asks only for changes after it.

## Authentication

- **Browser:** the `mp_session` cookie set by signing in at `/account`. Same-origin `fetch` sends
  it. Cross-site requests are refused (403) by the server's cross-origin protection.
- **App:** `Authorization: Bearer <token>`, from `POST /api/token`. A token lasts until it's
  revoked: by signing out in the app, by "Sign out" on the account page's device list, by an admin,
  by a password change or reset, or by the account being disabled or deleted. After any of these,
  every request answers 401.

Accounts are created by an admin at `/admin/users`. There is no sign-up endpoint.

## Endpoints

All bodies are JSON. Errors are `{"error": "message"}` with a 4xx/5xx status. Every response is
`Cache-Control: no-store`.

### `POST /api/token` — sign the app in

```json
{ "email": "a@example.com", "password": "…", "label": "Alex's iPad" }
```

- `200` `{"token": "…", "email": "a@example.com"}`. Store the token in the Keychain. The label is
  what the account page's device list shows (100 characters at most).
- `401` for every failure: unknown email, wrong password or disabled account. The message is always
  the same.
- `429` when rate-limited: 5 attempts per email, then one a minute, plus a per-IP ceiling. Shared
  with the web sign-in form.

### `DELETE /api/token` — sign the app out

Bearer token required. `204`; the token stops working immediately. Local history is kept.

### `GET /api/me`

`200` `{"email": "…"}`, or `401`. Use it to check whether a stored token or cookie is still good.

### `POST /api/sync`

Push new runs and deletions, and pull everything after `cursor`, in one round trip. The body is
limited to 16 MB (`413` beyond that), so push in batches of at most 500 runs.

Request (`push` and `deleted` may be omitted):

```json
{
  "cursor": 0,
  "push": {
    "scale": [{ "id": "…", "ts": 1760000000000, "...": "the run's own fields" }],
    "song": [],
    "learn": []
  },
  "deleted": [{ "kind": "song", "id": "…" }]
}
```

Response (always every key, always arrays, never `null`):

```json
{
  "cursor": 42,
  "records": { "scale": [ {…} ], "song": [], "learn": [] },
  "deleted": [ { "kind": "song", "id": "…" } ],
  "more": false,
  "rejected": [ { "kind": "scale", "id": "…", "reason": "ts must be a positive number" } ]
}
```

- **Server checks:** each pushed run must be a JSON object with a string `id` (1–64 characters), a
  positive numeric `ts`, and at most 64 KB. Anything else lands in `rejected` and the rest of the
  push is still stored. Drop rejected runs from the pending list rather than resending them for
  ever.
- **Order:** the push is applied first (runs, then deletions), then changes after `cursor` are
  returned. The client's own just-pushed runs therefore come back in `records`; merging by id makes
  that harmless.
- **Paging:** at most 1000 changes per response. While `more` is true, call again with the new
  `cursor` and nothing to push.
- **Atomic:** the push is one transaction. If the request fails, nothing was stored, and sending the
  same push again is safe.
- `400`: malformed JSON or a negative cursor. `401`: not signed in, meaning the token or cookie is
  dead. A server fault while checking credentials is a `500`, never a `401`, so a client never drops
  a live token because of a passing error.

## Client algorithm

Sync state is stored per device under `mp.v1.sync` (web: localStorage; iPad: the same key in
`FileStorage`):

```json
{
  "email": "a@example.com",
  "cursor": 42,
  "pendingAdds": [{ "kind": "song", "id": "…" }],
  "pendingDeletes": [{ "kind": "song", "id": "…" }],
  "lastSyncAt": 1760000000000
}
```

Its absence means sync is off (signed out). The token itself is not stored here: the iPad keeps it
in the Keychain, and the browser's cookie is HttpOnly.

1. **Recording a run** (`add`, `addSong`, `addLearn`), while sync is on: append `{kind, id}` to
   `pendingAdds`. Importing an export file queues every run it added.
2. **Deleting** (`removeSong`, `clear`), while sync is on: work out the ids actually removed, append
   them to `pendingDeletes`, and drop them from `pendingAdds`. The cap trim (`slice(-2000)`) queues
   nothing.
3. **Signing in** on a device that already has history: offer "Add this device's N runs to
   <email>?". On yes, queue every local run in `pendingAdds`. The server dedupes, so this is safe to
   offer on every sign-in. Then set `cursor` to 0 and sync.
4. **`sync()`:**
   1. Take up to 500 entries from `pendingAdds` and look each up in the local store. Skip any that
      are gone (trimmed by the cap, or deleted).
   2. Send them with all of `pendingDeletes` and the stored `cursor`.
   3. On `200`, remove exactly what was sent from the pending lists; entries queued while the
      request was in flight stay. Remove the `rejected` ones too.
   4. Merge `records` into the local arrays: union by id, sort by `ts`, cap at 2000.
   5. Remove the `deleted` ids from the local arrays, and from `pendingAdds`.
   6. Save `cursor` and `lastSyncAt`.
   7. Repeat while `more` is true or `pendingAdds` still has entries.
5. **`401`:** turn sync off by removing `mp.v1.sync` (and the Keychain token on the iPad). Keep the
   local history, and show "Signed out — sign in again to sync".
6. **Network errors and `5xx`:** keep everything pending and try again on the next trigger.
7. **Triggers:** page load or app launch; returning to the foreground (`visibilitychange` /
   `scenePhase == .active`); coming back online; a few seconds after each recorded run (debounced);
   and a "Sync now" button. Don't run two syncs at once.
8. **Signing out:** the web posts to `/account/logout`, the app sends `DELETE /api/token`. Then
   remove `mp.v1.sync`. Local history stays on the device.

## What is not synced

Settings (`mp.v1.settings`, including the per-song measure ranges) and uploaded scores (IndexedDB on
the web, files on the iPad) stay on each device. A run refers to its song by `songId`, so a song run
pulled onto a device without that score still shows in Progress under its stored title.
