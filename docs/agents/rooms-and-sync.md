# Rooms, sharing and sync

- **Household room (ADR-0019)**: `ui.householdRoom` is a persisted
  default join target; the app auto-joins it after config load unless a
  session resume or `?room=` link already won. Room failures toast and
  never block the UI (retry next launch) — never `await` a room
  operation on a render path. The auto-join is a JOIN, and a join
  creates the room when the relay doesn't know the code (ADR-0026), so a
  relay restart no longer strands the household. The join itself is
  SILENT (ADR-0084): no success toast — the room chip is the standing
  indicator; share lives on the roster sheet (`roster-share`).
- **Room lifecycle (ADR-0026)**: `join` is join-or-create (first peer
  ESTABLISHES the room, answered `created`; a known room answers
  `joined`); `create` is unchanged and still the host path. A room whose
  LAST peer leaves is KEPT, not deleted (ADR-0088 §5, amending ADR-0026
  — both runtimes now behave alike): the row and its state survive until
  the expiry clock fires, so the peer that returns re-joins a LIVE room
  and gets its plan back instead of re-seeding an empty room; a `create`
  onto an unoccupied room still establishes a fresh one (the rev FLOOR
  carries over). The client sends
  `{type:'keepalive'}` once a minute while live (one interval per
  socket, cleared on every end path) and the relay closes a room after
  30 days of no keepalive AND no state activity — the ONE room clock
  (ADR-0038's 2026-10-14 addendum: the old inactivity/idle clock pair
  collapsed once both windows sat at 30 days), refreshed by the SAME
  signals (keepalive included — a connected peer is not a silent room),
  and its firing tells
  the peers `room_expired` and clears their room code so a stale socket
  can never write into, or delete, a room re-created under that code
  (the window is ADR-0038's, widening ADR-0026). A socket belongs to
  at most one room: join/create detaches it from the previous one, so a
  client that moved on is never notified about the room it left. `rev`
  is monotone per CODE (the floor survives the room deletion, pruned at
  the room TTL) and is handed back in `created` / `joined`, so a
  re-created room never passes a stale snapshot off as newer. The client
  treats `room_expired`/`not_found` as TERMINAL (latched `roomGone`, no
  reconnect) — re-joining would join-or-create an empty room and read as
  silent household data loss; the pure retry decision lives in
  `src/lib/relayErrors.ts`, whose third answer `'ignore'` means "our
  frame was refused, the room is fine, do nothing". Keepalive is NEVER
  throttled; only create/join spend the throttle budget. The rules live
  in the shared core `server/relay-core/lifecycle.ts` (decision-table
  tested on every push) — the relay's code canonicalisation is the
  CLIENT's `normalizeRoomCode`, re-exported, so it cannot drift.
- **Room codes are three words (ADR-0021)**: the accepted format is the
  UNION — `amber-falcon-lantern` (`WORD_ROOM_CODE_RE`) or a legacy
  `ZZ9ZZZ` (`LEGACY_ROOM_CODE_RE`) — and everything that touches a code
  goes through `normalizeRoomCode()` in `src/lib/roomWords.ts` (forgiving
  in, canonical out; a PARTIAL word code is refused, never coerced).
  Codes are rolled CLIENT-side and the relay refuses a taken one with
  `code_taken` (the client re-rolls; collisions are tolerated by
  design). The relay's `normalizeCode` is GONE —
  `server/relay-core/codes.ts` re-exports the client's
  `normalizeRoomCode`, so there is one canonicaliser.
- **Room identity + presence (ADR-0063)**: every device carries a
  persisted identity (`mealime-planner:v1:identity`, backup slice
  `identity.json` in `STORE_SLICES`) — an immutable UUIDv7 from the
  `uuid` package plus an editable safe-word display name from
  `NAME_ADJECTIVES`/`NAME_NOUNS` in `roomWords.ts`, clamped by the ONE
  sanitizer `src/lib/profileName.ts` that the relays import too.
  Presence is RELAY-SIDE, never SharedState: the `peers` frame carries
  `members[]` (roster deduped per profile id, Guest rows for
  profile-less peers), profiles ride the upgrade URL (`pid`/`pname`) and
  `state.from` is the sender's profile id. The roster is LIVE-ONLY
  (cleared on every socket end path); ids are FIXED AT DIAL — a rename
  announces a `profile` frame, a restored backup announces the name and
  the sheet's you-marker keys on `room.joinedProfileId` (never re-dial
  to apply an id: the id is fixed at a socket's first admission by
  design, ADR-0063 — since ADR-0088 §5 a lone re-dial no longer even
  deletes the room, but the rule stands on its own).
  Profile ids are CLIENT-ASSERTED within the room-code trust boundary;
  binding them to a server secret is an auth layer, a future ADR.
  Avatars: `PersonAvatar` wraps `hashvatar` (dither, hashed on the NAME,
  `useDark` in the watch) with tones read from the design tokens.
- **Share room = one tap to the clipboard (ADR-0023)**: use
  `useShareRoomLink()` (`src/composables/useShareRoomLink.ts`), never
  `navigator.share` (no Web Share on plain-HTTP LAN) and never a raw
  clipboard call. It verifies the write by reading back and always says
  something — a share affordance must never fail silently.
- **Rooms are the ONLY way to share a plan (ADR-0051)**: the one-time
  `?p=` gzip+base64url link is retired; `src/lib/share.ts` and its spec
  are deleted, and an old `?p=` link now toasts "One-time plan links
  were removed" and has its param stripped — the decoder is GONE, do not
  reintroduce it. The Plan tab keeps a room-only Share sheet (room link,
  copy, cooked-history toggle, leave); there is no size ceiling, because
  a room link is the same length for any plan.
- **Room sync**: whole-state last-write-wins keyed by `rev`; shared
  state = `{plan, customItems, checked, cleared, customs, pantry,
  cookedHistory, filters, favorites, ratings, ratingTombstones,
  planIdentity}` — the SAME TWELVE keys the relay's per-store storage
  knows as `SYNCED_STORES`
  (ADR-0088 §6 cross-checks the two vocabularies; adding a key without a
  migration and a `SYNCED_STORES` entry is exactly the drift the gate
  catches — follow `.agents/skills/mealime-add-sync-store/SKILL.md`) —
  `cleared` is `clearedIngredients` (household state:
  clearing hides ingredients for everyone until re-planned/cooked),
  `customs` is the remembered custom-ingredient memory (household since
  2026-09-27, ADR-0012 change note), and `pantry` is the "In my
  kitchen" list (household since ADR-0090, superseding ADR-0087
  Decision 7's device-local ruling — whole-state LWW like `customs`,
  the 500-row `PANTRY_CAP` doubles as the payload cap, and the receiver
  re-derives every `nameKey` through `normalizePantryRows`).
  `favorites` + `ratings` are
  household PREFERENCE (ADR-0031) and the one deliberate exception to
  whole-state LWW: both are RECORDS carrying `updatedAt` and reconcile
  PER KEY, last writer by timestamp wins. `favorites` records are
  `{favorited, updatedAt}` — tombstones, so an un-star propagates and a
  stale push cannot resurrect it; `ratings` are
  `{rating, count, updatedAt}`. Two peers rating different recipes must
  not clobber each other, and an EQUAL timestamp is not a new opinion.
  Absent field = "don't touch" (never a wipe), both are emitted only
  when non-empty, and there is ONE push writer —
  `schedulePush(immediate?)`, guarded by `applyingRemote`; preference
  edits pass `immediate` and skip the debounce, everything else keeps
  it.
- **Relay storage is per-store SQLite (ADR-0088)**: both runtimes keep
  ONE TABLE per `SYNCED_STORES` key (`store_<snake_name>`, JSON-text
  value with a `json_valid` CHECK, per-store `created_at`/`updated_at`)
  plus the room row, the rev floor and the peer serial — the Bun relay
  behind `RELAY_DB_PATH` (default `/data/relay.sqlite3`, Docker volume
  `relay-data`), the Durable Object in its own storage SQL. The
  deprecated `room.state` column is a WRITE-ONLY legacy-blob mirror for
  30 days after migration 002 (ADR-0088's 2026-10-14 addendum): upserts
  bind the room's merged snapshot into it so a downgraded, pre-per-store
  relay binary keeps serving real rooms, then bind NULL again — no read
  path of the new binary ever touches it. The split
  (`splitSnapshot`) writes ONLY the keys present in the payload — the
  standing "absent = don't-touch" rule is enforced at the shared split,
  so no adapter can turn a missing key into a wipe — while an explicit
  `planIdentity: null` is written through (ADR-0034's always-sent
  exception). `joinSnapshot` rebuilds the single snapshot a `joined`
  needs. The schema is versioned by ONE migration runner in the core
  (`server/relay-core/migrations.ts`, `schema_migrations` ledger,
  applied at Bun startup and lazily per event in the DO): adding a
  synchronized store is now a migration on BOTH runtimes, in the same
  change as the `SYNCED_STORES` entry (the skill above carries the
  touch surface). The wire protocol did NOT move: this re-scopes
  storage, not sync semantics.
- **Join reconciliation (ADR-0028)**: a `joined` that ADOPTED the room's
  snapshot does NOT push afterwards (the echo re-published a possibly
  stale snapshot at a higher rev and could freeze the household on old
  state); a join that did not adopt (empty room, or the `ROOM_REV_KEY`
  floor rejected the snapshot) still pushes. A local edit queued inside
  the 300ms push debounce outranks a snapshot that arrives before its
  push, and an edit that could not be sent because the socket was not
  live is published on join instead of being silently adopted over. New
  `SharedState` members are OPTIONAL and absence means "don't touch",
  never "wipe".
- **Cooked history (ADR-0032, supersedes ADR-0011's opt-in)**:
  `cookedHistory` is HOUSEHOLD state by default: the payload carries it
  unless the SENDER has opted out via `shareCookedHistory` (default ON,
  and the opt-out is permanent — `ui.historyShareDefaultMigrated` is the
  one-time default migration marker). Peers apply it with
  `plan.mergeCookedHistory` (a UNION, never a replace: history is
  append-only and every device pushes at once, so a replace would let
  the last writer erase the other phones' cooks). A backup import is the
  one exception and keeps `replaceCookedHistory`. The relay preserves a
  previously stored `cookedHistory` when a snapshot arrives WITHOUT the
  key (an opted-out sender is silent about history, never a wipe), so a
  later joiner still adopts the household's log. The toggle is surfaced
  in Settings → Household sync and the Plan tab's room sheet; changing
  the default again needs a new ADR, not an edit to ADR-0032.
- **Backup registry (standing rule, ADR-0013)**: every persisted store
  slice MUST be registered in `STORE_SLICES` (src/lib/backup.ts) in the
  same change that adds the store — export, import and validation all
  iterate that single registry. Unregistered slices make every export
  fail loudly (assertRegistryCoverage + e2e registry-coverage case).
  Import is validation-first and atomic: never partial-apply. The
  backup & restore UI lives on the `/settings` tab (ADR-0016) — MOVED
  out of Plan, never duplicated. Registered today: plan + custom items +
  cleared ingredients, cooked history, ingredients, checked, custom
  ingredients, quick filters + settings, `favourites.json` (id array)
  and `ratings.json` (ADR-0031: `{id, rating, count, updatedAt}` rows
  whose import RECONCILES per record, so an older backup cannot roll
  back a newer rating).
