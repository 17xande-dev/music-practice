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

- **`input` on every record.** All three record types carry `input: "midi" | "screen"`: how the run
  was played. `"midi"` means every graded note came from a MIDI instrument (the guitar's microphone
  counts as `"midi"`, a real instrument). `"screen"` means at least one graded note came from the
  screen: the drawn piano (mouse or touch) or the computer's typing keys. A Learn pass follows the
  same rule over its notes. A record **without** the field (made before it existed) reads as
  `"midi"`; new records always write it. The server stores it as-is, and import and sync carry it
  untouched. Anything other than those two strings makes the record invalid on the client.
  Stats are kept apart by input: personal bests ("up from X%", "your best") only compare runs of
  the same input (`input` is part of `exerciseKey` and `songKey`), and Progress trends, heat strips
  and Learn time show one input at a time (setting `mp.v1.settings` `progressInput`, default
  `"midi"`, validated as exactly those two values; the web page labels them "Instrument" and
  "On-screen").
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
- `400` when `email` is not a bare address (after trimming and lower-casing) or is over 254 bytes.
  This is decided before the rate limiter, so it does not count as an attempt.
- `429` when rate-limited: 5 attempts per email, then one a minute, plus a per-IP ceiling of 10 in a
  burst (an IPv6 client counts by its /64). Shared with the web sign-in form.
- `503` with a `Retry-After` header (seconds) when the server is busy: at most 3 password checks run
  at once, and a request waits up to 2 seconds for one. Nothing was decided; try again after the
  delay. Treat it like any other 5xx (keep the credentials form, clear nothing).
- The request body is limited to 4 KB.

### `DELETE /api/token` — sign the app out

Bearer token required. `204`; the token stops working immediately. Local history is kept.

### `GET /api/me`

`200` `{"email": "…"}`, or `401`. Use it to check whether a stored token or cookie is still good.

### `POST /api/sync`

Push new runs and deletions, and pull everything after `cursor`, in one round trip.

Limits on a request (a client must stay inside all of them):

- At most **1000 records in total** across every kind in `push`, and at most **1000 entries in
  `deleted`**. More is `400` and nothing is stored. Clients send far fewer (below).
- The body is at most 16 MB (`413` beyond that). Clients keep the record data of one request to about
  **4 MB of JSON** (`4 * 1024 * 1024` bytes of serialized records, always at least one record) and at
  most **500 records**, deletions at most 1000.
- On `413`, halve the batch (records and bytes) and send again; a single record that still gets `413`
  is an error to report, not to retry.

Request (`push` and `deleted` may be omitted; `account` is optional on the wire, so older iPad builds
that do not send it keep working, but the web client and current iPad builds always send it):

```json
{
  "account": "a@example.com",
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

- **`account`** is the email the client believes it is signed in as (its stored sync state's `email`).
  If it is present and, after trimming and lower-casing, differs from the authenticated user's email
  (or is not a valid address), the server answers **`409` `{"error":"account mismatch"}`** and stores
  and returns nothing. This stops a shared browser (or an app whose token was replaced) pushing one
  person's history into another's account. Omitting it skips the check.
- **Record identity:** `id` is a string of 1-64 **bytes of UTF-8** (clients count bytes, not UTF-16
  units or characters), `ts` a number greater than 0. The member names are exactly `id` and `ts`, lower
  case; a record with two top-level names that match case-insensitively (`"id"` and `"ID"`, or a
  repeated name) is rejected.
- **Server checks:** each pushed run must be a JSON object with a string `id` (1-64 bytes), a numeric
  `ts` greater than 0, at most 64 KB, and no case-insensitive duplicate member names. Anything else
  lands in `rejected` and the rest of the push is still stored. Each `rejected` entry carries the record's `id` whenever the pushed record had
  a string `id`, whatever the reason (oversize, bad `ts`, unknown kind, even an empty id); it is
  omitted only when there is no string id at all. Drop rejected runs from the pending list rather than resending them for
  ever.
- **Order:** the push is applied first (runs, then deletions), then changes after `cursor` are
  returned. The client's own just-pushed runs therefore come back in `records`; merging by id makes
  that harmless.
- **Paging:** a response carries at most 1000 changes and at most about 4 MB of record data (a
  tombstone counts as a small constant), and always at least one change when there is one. `more` is
  true when either cap stopped the page. While `more` is true, call again with the new `cursor` and
  nothing to push.
- **Atomic:** the push is one transaction. If the request fails, nothing was stored, and sending the
  same push again is safe.
- `400`: malformed JSON, a negative cursor, or more than 1000 records or deletions. `409`: `account`
  does not match the signed-in user. `413`: body over 16 MB. `401`: not signed in, meaning the token or cookie is
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
   1. Take entries from the front of `pendingAdds`, up to 500 and until their serialized JSON reaches
      4 MB (always at least one), looking each up in the local store. Entries whose run is gone
      (trimmed by the cap, or deleted) count as taken and send nothing.
   2. Send them with up to 1000 of `pendingDeletes`, the stored `cursor` and `account` (the stored
      `email`). If sync was turned off, or on for another account, while the request was out (the
      web re-reads the stored state and compares `email`, since another tab shares it), throw the
      response away.
   3. On `200`, remove exactly what was sent from the pending lists; entries queued while the
      request was in flight stay. Remove the `rejected` ones too.
   4. Merge `records` into the local arrays: union by id, sort by `ts`, cap at 2000.
   5. Remove the `deleted` ids from the local arrays, and from `pendingAdds`.
   6. Save `cursor` and `lastSyncAt`.
   7. Repeat while `more` is true or `pendingAdds` still has entries.
5. **`401`:** turn sync off by removing `mp.v1.sync` (and the Keychain token on the iPad). Keep the
   local history, and show "Signed out — sign in again to sync".
   **`409`:** the session belongs to another account than the one this device syncs with. Remove the
   sync state (queue and cursor included) as for `401`, keep the local history, and say the account
   changed. On the iPad the token is still valid, so do not delete it automatically: show "this iPad
   is signed in as X; sync stopped" and let the person decide.
   **`413`:** halve the batch (records and bytes) and retry; an error if a single record is refused.
6. **Network errors and `5xx`:** keep everything pending and try again on the next trigger.
7. **Triggers:** page load or app launch; returning to the foreground (`visibilitychange` /
   `scenePhase == .active`); coming back online; a few seconds after each recorded run (debounced);
   and a "Sync now" button. Don't run two syncs at once.
8. **Signing out:** the web posts to `/account/logout`, the app sends `DELETE /api/token`. Then
   remove `mp.v1.sync`. Local history stays on the device. The web also clears it on the signed-out
   page (`/account?notice=signed-out`, via `/static/dist/signout.js`), so any sign-out path leaves no
   state behind.
9. **No progress is an error.** If another round is wanted (`more`, or entries still pending) but the
   last one removed nothing from the queues, pulled no record or tombstone and did not move the
   cursor, stop and report an error instead of repeating the request.

## What is not synced

Settings (`mp.v1.settings`, including the per-song measure ranges) and uploaded scores (IndexedDB on
the web, files on the iPad) stay on each device. A run refers to its song by `songId`, so a song run
pulled onto a device without that score still shows in Progress under its stored title.
