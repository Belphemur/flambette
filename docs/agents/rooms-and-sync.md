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
  LAST peer leaves is deleted immediately (state included) — the peer
  that returns re-joins, which re-creates it. The client sends
  `{type:'keepalive'}` once a minute while live (one interval per
  socket, cleared on every end path) and the relay closes a room after
  24h of no keepalive AND no state activity; the 7-day idle TTL is a
  redundant backstop refreshed by the SAME signals (keepalive included —
  a connected peer is not an idle room), and either clock firing tells
  the peers `room_expired` and clears their room code so a stale socket
  can never write into, or delete, a room re-created under that code
  (the windows are ADR-0038's, widening ADR-0026). A socket belongs to
  at most one room: join/create detaches it from the previous one, so a
  client that moved on is never notified about the room it left. `rev`
  is monotone per CODE (the floor survives the room deletion, pruned at
  the idle TTL) and is handed back in `created` / `joined`, so a
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
  to apply an id: as the only peer it deletes the room, ADR-0026).
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
  state = `{plan, customItems, checked, cleared, customs, favorites,
  ratings}` — `cleared` is `clearedIngredients` (household state:
  clearing hides ingredients for everyone until re-planned/cooked) and
  `customs` is the remembered custom-ingredient memory (household since
  2026-09-27, ADR-0012 change note). `favorites` + `ratings` are
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
