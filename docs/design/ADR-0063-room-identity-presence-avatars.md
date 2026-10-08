# ADR-0063: Room identity — device UUIDv7, safe-word names, live relay presence, and hashvatar avatars

Status: accepted (2026-10-08)

## Context

The room has people, but the system only knows sockets. The header "live
bullet" (ADR-0049) is a passive status chip: the relay reports a headcount
(`peers` frames), `SharedState` carries household data, and nothing anywhere —
wire, client or docs — carries a notion of *who* is in the room. Two people
tapping the chip today learn "3 in room" and nothing else.

The owner asked for: a per-person identity generated from safe words
(recognizable when someone taps the chip), backed by a proper UUID (v7
preferred) that survives across sessions and can later attribute actions
("cooked by whom", notifications); an editable display name; a roster of who is
CURRENTLY connected, kept live by the relay; and a generated avatar per person,
specified later as the `hashvatar` npm package in dither mode, animated.

Two rulings were made up front with the owner:

1. **Dependencies are allowed.** The repo's earlier "no new deps for ~20
   lines" reflex is lifted: pull the standard `uuid` package rather than
   hand-rolling UUIDv7.
2. **Presence is relay-side, not SharedState.** The relay keeps who is
   connected right now and keeps that up to date. The roster is live truth,
   not household state, and this ADR covers the whole change.

DESIGN.md was updated in the same change (avatar tokens, the roster-sheet
component rules, the chip's tap affordance); this record explains the
architecture behind it.

## Decision

### 1. Identity — a dedicated persisted store

`src/stores/identity.ts`, persisted under `mealime-planner:v1:identity`:

```ts
{ id: string /* UUIDv7, immutable */, name: string /* editable */ }
```

- **Generation timing** (the owner's rule: generated on first join, kept
  after): the id+name are generated when the device first joins/creates a
  room, and at `afterHydrate` when the store is absent but the device is
  ALREADY in a room (`ui.householdRoom` set) — the migration path for
  existing room members, so an upgrade never shows a room of anonymous
  peers. Identity is a NEW slice, so "absent" is unambiguous — unlike the
  ADR-0032 pattern there is no legacy-blob shape to read around; a fresh
  install that never joins simply never generates one.
- **The id never changes and is never regenerated** once present. It is a
  device identity (like `state.from`-scoping), not an account.
- **UUIDv7 comes from the `uuid` package (v14, zero runtime deps)** —
  `crypto.randomUUID()` is v4-only, and hand-rolling time-ordered ids is
  exactly the kind of code the owner ruled we should not write when a
  standard library exists. New runtime dep, surfaced here as the trade-off
  the owner already accepted.
- **Name words**: curated `NAME_ADJECTIVES` + `NAME_NOUNS` lists in
  `src/lib/roomWords.ts`, same shape as the room lists (lowercase ASCII,
  3–10 letters, `WORD_RE`). The name is `<adjective>-<noun>`, displayed
  Title Case ("Brave Otter"). The lists are deliberately NOT the room-code
  lists, so a name never reads like a room code. Name conflicts are fine:
  the roster disambiguates by pattern and context, never by forced
  uniqueness.
- **Editing**: Settings → Household sync gains a "Your name" field with the
  avatar preview. Editing the name never touches the id, and while
  connected it pushes a `profile` frame (below) so the roster updates
  immediately.
- **Backup (ADR-0013 standing rule)**: the slice registers in
  `STORE_SLICES` as `identity.json` in the same change. Import is
  replace-on-apply (identity is DEVICE-scoped, deliberately NOT household
  state — a backup restores whose device this is). The validator requires
  a UUID-parseable id and a non-empty name ≤ 40 visible chars.

Deliberate deviation from the original sketch: the sketch put identity on
the `ui` slice; the design gives it its own store so the backup slice is
self-describing and the ADR-0031 store pattern (favourites, ratings) is
followed instead of growing `ui` further.

### 2. Live presence — the relay keeps the roster

The relay learns who a socket is and fans out the roster on every membership
change. All of it is ADDITIVE to the wire protocol, so any relay/client
combination works:

- **Client → relay**: `join` and `create` gain an optional
  `profile: { id: string, name: string }`. A mid-session rename sends
  `{ type: 'profile', name }` — the id is fixed at join and cannot be
  changed by any later frame (the relay ignores an `id` in `profile`).
- **Validation lives in the core** (`server/relay-core/`): a
  `normalizeProfile` helper clamps/validates the name (trim, strip control
  characters, 1–40 visible chars, fallback `Guest`) and requires a
  UUID-parseable id. A frame without a profile is a legacy peer: it keeps
  its serial `from` and appears in the roster as an unnamed `Guest` row.
- **Relay → client**: the `peers` frame (ADR-0049) gains an optional
  `members: { id: string | null, name: string }[]` — the FULL roster,
  replacing the previous one, sent on the exact same occasions the count is
  already broadcast (join, leave, rename, expiry). One frame, one truth;
  the count badge stays the relay's headcount. Older clients ignore the
  unknown field, so the protocol widens without a version bump.
- **Deduplication is a core decision**: a roster entry is keyed by profile
  id, so the same device with two tabs (two sockets, one identity) appears
  ONCE. Unnamed legacy sockets each appear as a `Guest` row.
- **Bun adapter** (`server/relay.ts`): the profile rides `SocketData`; the
  roster is derived from the room's peer set at fan-out time. No new
  storage — presence is socket-lifetime state by definition.
- **Cloudflare adapter** (`server/worker/room.ts`): the profile is written
  with `serializeAttachment()` on accept and re-serialized on rename, so
  the roster survives hibernation — a hibernated WebSocket is still a
  CONNECTED peer, and `getWebSockets()` + `deserializeAttachment()` rebuild
  the roster without any SQL. Presence is deliberately NOT a table: the
  room's expiry already wipes it with the room row.
- **Semantics stay in `relay-core` (ADR-0040)**: roster construction,
  dedupe, name clamping and the fan-out occasions are core functions +
  decision-table rows in `lifecycle.test.ts`; the adapters differ in store
  and nowhere else.
- **Per-push attribution lands for free**: the relay already echoes a
  `from` on `state` fan-out (today a per-code serial). When the sending
  socket carries a profile, `from` becomes the sender's PROFILE ID
  (serial fallback for legacy peers). Every future "show who did this"
  feature can key on that field with no new frame — this retires the
  sketch's open question (b) in the cheap direction.
- **Explicitly NOT done this phase**: nothing consumes `from` beyond the
  roster; no per-action attribution UI; no notification plumbing. The id
  exists so those features become additive later.

Presence is never pushed through `SharedState`, never merged, never backed
up: it is the live room, not the household. A roster member who crashes
without `leave` disappears the moment their socket dies — honest, if
occasionally abrupt.

### 3. Avatar — hashvatar, dither mode, animated

`src/lib/personAvatar.ts` + `PersonAvatar.vue` wrap the `hashvatar` package
(v0.1.2, zero runtime deps, ESM; its `react` peer is
`peerDependenciesMeta.optional`, so a Vue app adds it cleanly — new runtime
dep, accepted by the owner):

- `createHashvatar({ hash, mode: 'dither', animated, size, tones })`,
  rendered to a `<canvas>` clipped to a circle. The hash input is the
  DISPLAY NAME — the owner's stated requirement — so two devices showing
  the same person render the same pattern, and the pattern follows renames.
  Consequence, accepted and documented in DESIGN.md: identical names render
  identical patterns (conflicts are fine), and a rename re-skins the
  pattern everywhere.
- **Tones are read at runtime from CSS custom properties** — the existing
  `hue-*` / `meal-*` / `nutrition-*` families — never a hex literal in
  `src/`, so avatars stay inside the design system's palette and a palette
  change re-skins every avatar (DESIGN.md's identity-art paragraph).
- **Animation** (`animated: true`) collapses to a still pattern under
  `prefers-reduced-motion: reduce` (`useReducedMotion` from
  `@vueuse/core`), and `destroy()` runs on unmount and on every hash change
  — the animation loop must never outlive its row.
- **SSR-safety is moot** (plain Vite SPA), but the component renders into
  a canvas created in `onMounted` and is not exercised during unit tests
  beyond the pure tone/hash helpers.

### 4. The chip becomes a door

Tapping the room chip opens a roster sheet: header "N in room" (the relay's
live count), rows of avatar + name with a quiet text "you" marker on the
device's own row, empty roster data degrading to the plain count. The chip
keeps its status semantics, its TooltipBubble description and its
`cursor-help` affordance, gains `aria-expanded`, and remains e2e-pinned at
the ADR-0049 size. `data-test` hooks: `room-chip` (existing, now a button),
`roster-sheet`, `roster-row`, `roster-you`, and Settings'
`identity-name-input` / `identity-avatar`.

### 5. Test gates

- **Unit**: `identity` store (generation timing incl. the in-room migration
  path, rename, immutability of id), `uuid` v7 shape/time-sortability, name
  word-list invariants, `normalizeProfile` clamps, roster dedupe + fan-out
  occasions in `lifecycle.test.ts`, avatar tone derivation from CSS vars.
- **e2e**: chip tap opens the roster sheet; roster lists a joined second
  browser (room.spec's multi-context pattern); rename in Settings updates
  the roster live; backup round-trip carries `identity.json`; registry
  coverage stays green; the animated avatar honors reduced motion.

## Change note (2026-10-09, implementation)

Three implementation facts deviate from the letter of §1/§2/§3 without
changing any decision. All were forced by ADR-0038's upgrade-URL intent
carrier (the client does not send `join`/`create` frames; it dials
`?op=create|join&room=...`):

1. **Identity is generated at the join/create DIAL, not on the success
   frame.** The profile has to ride the upgrade URL, which is built
   before the relay can answer. `pid`/`pname` travel the SAME query the
   intent already uses, so the very first roster fan-out is already
   complete — the joining peer never flashes as a Guest row. A dial
   whose join then fails leaves an unused identity behind, which is
   harmless (the owner's rule — "generated on first join, kept after" —
   is about a fresh install never minting one, and that still holds:
   `connect()` is only reached from room business).
2. **The relay honours a `profile` on `join`/`create` MESSAGE frames
   too** (first contact adopts id + name; later frames rename only), so
   the §2 frame contract is real for message-protocol clients; the
   client itself uses the URL.
3. **Reduced motion is `useMediaQuery('(prefers-reduced-motion: reduce)')`,
   not `useReducedMotion()`** — the pinned @vueuse/core build does not
   export the latter. Same query, same reactivity, same semantics.

## Consequences

- **Two new runtime deps**: `uuid` v14 (~small, zero-dep) and `hashvatar`
  0.1.2 (zero-dep, optional-only react peer). Both were surfaced and
  accepted; the standing "no new deps without surfacing" rule is satisfied
  by this record, and the deps-allowed ruling stands.
- **The wire protocol widens additively** in three places (`join`/`create`
  profile, `profile` message, `peers.members`). Every combination of old
  and new relay/client degrades gracefully: unknown fields are ignored,
  missing profiles render as `Guest`, and the count badge is untouched.
- **Deploy order does not matter** for the first time in a protocol change:
  a new client against an old relay loses roster + attribution but keeps
  identity locally; an old client against a new relay is a `Guest` row.
- **Presence is ephemeral and honest**: no persistence, no stale names
  after crashes, roster dies with the sockets. The DO's deliberate
  room-row-survival (ADR-0038 §4) does not resurrect it.
- **Renames are visible**: the roster and the pattern both follow the name;
  the id never moves, so attribution history stays coherent across renames.
- **DESIGN.md + ADR index** ship with the change; `DESIGN.tokens.json` is
  regenerated only if the export output changes (avatar size tokens do not
  reach it).

## Alternatives considered

- **Roster as `SharedState.members` with per-key reconciliation** (the
  original sketch): rejected by the owner's ruling — it models "who has
  ever been in the household", not "who is connected now", and would have
  made renames converge through LWW instead of the relay's live truth.
  SharedState stays household data only.
- **A relay `presence` frame separate from `peers`**: rejected — two
  frames for one fact invites drift between count and roster; the `peers`
  fan-out occasions are already exactly right.
- **Persisting the roster in room state / SQL**: rejected — crashes and
  hibernation would strand stale members; socket-lifetime state cannot lie.
- **Hand-rolled UUIDv7 (~20 lines)**: rejected per the owner's ruling —
  standard library over hand-rolled crypto now that deps are allowed.
- **Gravatar-style initials SVG**: superseded by the owner's hashvatar
  choice (dither, animated) before this record was written.
- **Hashing the UUID instead of the name**: more stable across renames,
  but the owner specified name-based ("something like Gravatar does") and
  identical-name collision is an accepted, documented consequence. If the
  roster ever grows past a household, revisit.
- **Relay-minted guest numbers ("Guest 2")**: better than nothing, worse
  than safe words, and unnecessary once the client carries a profile.