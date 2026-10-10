# iPad sync: handoff

The server side of accounts and history sync is done in this repo. The iPad app
(`~/dev/music-practice-app`) has **not been changed**. This page is the brief for the session that
adds sync there. The wire contract is [`sync-api.md`](sync-api.md); read it first. Everything below
is about fitting that contract into the Swift app.

## What already exists (this repo)

| Piece           | Where                                                    | Notes                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts        | `internal/account`, `/admin/users`                       | An admin creates the account at `/admin/users`, and a password is generated and shown once. There is no sign-up. The person signs in on the web or in the app with that password, then changes it at `/account`. |
| App sign-in     | `POST /api/token`                                        | Returns a bearer token that lasts until revoked. Rate-limited and shares the web form's single failure message. The `label` you send (e.g. the device name) is what `/account` lists under "Signed-in devices".  |
| App sign-out    | `DELETE /api/token`                                      | `204`; the token is dead at once.                                                                                                                                                                                |
| Sync            | `POST /api/sync`                                         | Push and pull in one round trip, with a cursor, tombstones for deletions, and `rejected` for runs it won't store. Tested in `internal/handler/api_test.go` and `internal/history`.                               |
| Web client      | `frontend/lib/sync.ts`, `frontend/lib/progress_store.ts` | The reference implementation of the client algorithm in `sync-api.md`. Port its behaviour, and its tests where they translate.                                                                                   |
| Production host | `https://music.17xande.dev`                              | HTTPS through Cloudflare, so default ATS is satisfied.                                                                                                                                                           |

## Where it goes in the iPad app

From a survey of the app as it stands (line numbers are approximate):

- **`MusicCore/Sources/MusicCore/ProgressStore.swift`.** This is the port of the web store, using
  the same keys (`mp.v1.sessions`, `mp.v1.songSessions`, `mp.v1.learn`) and the same JSON.
  - Mirror the web changes: factor the per-array merge out of `importJSON` / `static merge` (~385)
    into `mergeRecords(kind:records:)` and `removeIds(kind:ids:)`.
  - Add the `mp.v1.sync` state (`email`, `cursor`, `pendingAdds`, `pendingDeletes`, `lastSyncAt`).
  - Make `add` (~254), `addSong` (~268), `addLearn` (~282) and `importJSON` queue pending adds while
    sync is on.
  - Make `removeSong` (~307) and `clear` (~315) queue the ids they actually remove as pending
    deletes.
  - The `maxSessions` trim must queue nothing.
- **`HistoryRecord` protocol (~97).** It already has `id: String` and `ts: Double`, which is all the
  server checks. Records must be encoded exactly as today: the server stores and returns them byte
  for byte, and the web reads them.
- **New `MusicCore` `SyncClient`.** Inject a transport protocol
  (`func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)` or similar) so the
  whole algorithm runs under `swift test` with a fake. Behaviour to copy from the web:
  - batches of at most 500;
  - clear only what was sent;
  - drop `rejected` runs;
  - loop while `more` is true;
  - on `401`, turn sync off but keep history;
  - on network errors and `5xx`, keep everything pending;
  - single flight: never two syncs at once.
- **`Sources/MusicPractice/Store/` — new `Keychain.swift`.** Store the token as a generic-password
  item (service e.g. `dev.alexf.MusicPractice.sync`). The app's own keychain needs no entitlement.
  Never put the token in `FileStorage` or `UserDefaults`.
- **`URLSession` transport** in the app target. The base URL is `https://music.17xande.dev`, plus a
  DEBUG-only override for testing against a local server (see "Testing" below).
- **`Sources/MusicPractice/App/AppModel.swift`.** `store` is created inline (~14). Own the
  `SyncClient` here too, and trigger sync:
  - at launch;
  - when `scenePhase` becomes `.active`;
  - a few seconds after each recorded run (debounced);
  - from a "Sync now" button.
- **`Sources/MusicPractice/Progress/ProgressPage.swift`.** `dataSection` (~216) holds the "History
  is kept only on this iPad…" text and the Export, Import and Clear buttons. Add a "Sync" section
  there:
  - **Signed out:** "Sign in" opens a sheet with email and password, which calls `POST /api/token`
    with `label: UIDevice.current.name`.
  - **Signed in:** "Synced with <email> · 2 min ago", a "Sync now" button, and "Sign out", which
    sends `DELETE /api/token`, deletes the Keychain item and removes `mp.v1.sync`.
  - **First sign-in with local history:** offer "Add this iPad's N runs to <email>?".
  - Update the "kept only on this iPad" wording, and the Clear confirmation: when signed in,
    clearing also deletes the runs from the account and other devices.
- **Debug hooks** (`Debug/DebugServer.swift` pattern, DEBUG only): `sync` (run a sync and return the
  result), `syncstate` (dump `mp.v1.sync`, with the token redacted), and `signin?email=&password=`.
  These let a Linux session drive it through `pymobiledevice3 usbmux
  forward 8765 8765` without
  tapping.

## Things that are easy to get wrong

- **Ids are lowercase UUIDs on both platforms** (`newId()` in Swift, `crypto.randomUUID()` on the
  web), but the web falls back to a non-UUID id when there is no secure context. Treat ids as opaque
  strings of up to 64 characters, and never parse them.
- **The cap is not a deletion.** A device trimming to 2000 must not send tombstones, or one device's
  trim would delete old runs from every device.
- **Deletions win.** After a pull says an id is deleted, remove it locally _and_ from `pendingAdds`.
  Otherwise the next push re-sends it (harmless, since the server keeps the tombstone, but wasted).
- **Settings and scores are not synced.** That includes `mp.ipad.songRanges` and the song library. A
  song run pulled from the web for a score the iPad doesn't have still has its `title`, so Progress
  can show it.
- **A `401` means the token is dead**, not that the request was bad. Possible causes: signed out on
  `/account`, a password change or reset, or the account disabled or deleted. Clear the token and
  sync state, keep history, and show "Signed out".

## Testing

- **`swift test`:** cover the store's queueing and `SyncClient` against a fake transport. There's a
  JSON fixture shape to share: `WebCompatTests` already checks that the two apps' records match.
- **Against a local server:** run this repo with `make dev` (or `DB_PATH=… go run .`) on the Linux
  box and create a user with `go run . -add-admin you@example.com`.
  - The iPad can't reach `localhost`, and plain HTTP to a LAN address needs an ATS exception. Add
    `NSAllowsLocalNetworking`, or an exception domain, **in DEBUG builds only**.
  - Simpler: test against production with a throwaway account made at
    `https://music.17xande.dev/admin/users`, and delete it afterwards.
- **End to end:**
  1. Sign in on the iPad (`signin` hook).
  2. Record a run (`songsimulate`) and `sync`.
  3. Check that it appears on the web Progress page after the browser syncs.
  4. Record one on the web and check that `history` on the iPad shows it after `sync`.
  5. Remove a song on one side, and check that its runs disappear on the other.
