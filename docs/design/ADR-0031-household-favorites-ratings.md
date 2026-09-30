# ADR-0031: Shared household favourites + per-recipe ratings

**Status:** Accepted (2026-09-30)
**Extends:** ADR-0011 (cooked history is personal), ADR-0012 (customs are
household state), ADR-0024/0027 (Auto-Plan ranking), ADR-0028 (filter
sync + join reconciliation), ADR-0013 (backup registry).
**Numbering note:** the phase brief asked for ADR-0030; that number is
taken by `ADR-0030-auto-plan-preview.md` (merged 2026-09-29), so this
record is ADR-0031. Accepted ADRs are never renumbered.

## Context

Two kinds of "I like this" lived in the app and neither of them left
the device:

- **Favourites** (`src/stores/favourites.ts`) — a `Set<number>` of
  variant ids, seeded on FIRST RUN from the user's own Mealime snapshot
  (`favourited_feasible_variants`, 56 ids) and never cleared. It was
  already covered by the backup registry, so a device could restore its
  stars — but two phones in one household could not see each other's.
- **Catalog ratings** (`variant_meta.rating`, 0..1) — read-only crowd
  data. Correctly never writable, and correctly excluded from the room
  payload: it is the CATALOG's opinion, not the household's.

What was missing is the household's own opinion, which is a different
thing: it should be shared live, it should survive a restore, and it
should be able to steer Auto-Plan without ever being confused with the
catalog's score.

## Decision

### 1. Favourites: tombstones, not a bare set

`SharedState` gains
`favorites?: Record<variantId, {favorited, updatedAt}>` — the starred
set WITH delete markers.

A bare `number[]` can only ever be union-merged, and that is exactly the
delete anomaly: B un-stars a recipe, and the next push from anyone who
still has it starred brings it straight back. The user's own delete
would be undone by a peer who never touched it.

So the store keeps RECORDS internally (`{favorited, updatedAt}` per
recipe) and MATERIALIZES the live `Set` from the entries that are
`favorited: true` — on every write, synchronously, so a caller that
toggles and then reads (or the room's `snapshot()`) never sees a stale
set. `toggleFavourite` writes `{favorited, updatedAt: Date.now()}`.

Unchanged by this ADR, deliberately:

- the seeding (first run, from the user's own snapshot — now via
  `seedFrom`, which only ADDS, so a peer record that landed before the
  catalog finished loading is never clobbered by the seed);
- the public `Set<number>` interface;
- the persisted ARRAY format under `mealime-planner:v1:favourites`
  (tombstones are in-memory only, see §7);
- the `favourites.json` backup slice.

Tombstones need no cleanup: each is overwritten by the next record for
that recipe, and the map is keyed by recipe, so it is compact by
construction.

Two invariants this shape buys, both of which cost us something in the
first cut:

- **`records` is the single source of truth** and the public `Set` is a
  `computed` over it. The earlier design kept a real `Set` ref mirrored
  from the records; persistence hydration then assigned the ref directly
  and a `watch` had to rebuild the records — a deferred rebuild that a
  toggle landing before the flush could beat, silently dropping every
  persisted favourite. Deriving the set removes the flush window
  entirely: it is correct on the first read after hydration, which is
  also what the room's `snapshot()` needs.
- **A default is not an opinion.** First-run seeding and persistence
  hydration both stamp their records `DEFAULT_STAMP` (0), and the room's
  favourites watcher skips a change in which every touched record is a
  default. Without that, a device that seeds during a join would look
  like it had made a local edit: `unsentLocalEdit` would suppress the
  join handler's adoption and it would publish its own (possibly empty)
  state over the room's plan — a startup artifact dressed as an edit.
  A real toggle is stamped with the clock and is still published.

### 3. Ratings: a new store, seeded EMPTY

`src/stores/rating.ts` — `useRatingStore`, a plain
`Record<variantId, {rating, count, updatedAt}>` (0..5 stars in 0.5 steps),
persisted under `mealime-planner:v1:ratings` with NO custom serializer (a
record round-trips as itself; a Map or Set would not).

It seeds **empty**, and this is the load-bearing difference from the
favourites store: `variant_meta.rating` is crowd truth and is never
copied into the ratings store. A rating is opinion; importing opinion as
if it were the user's own would be a lie in the data model. The
unrated fallback is the catalog rating, shown dimmed next to the stars.

Re-rating a recipe from this device REPLACES the value and KEEPS `count`:
the count is a household-size signal for smoothing, and one person
changing their mind must not inflate it. Every write is stamped with
`updatedAt` (unix ms) — the merge key below. The stamp is an injectable
parameter so the reconciliation rules are unit-testable with a synthetic
clock instead of a sleep.

### 4. One merge rule for the whole preference surface

Ratings reconcile per record, last writer wins by TIMESTAMP — and so do
favourites. One rule, one code shape (`mergeRemote` on each store), one
place to reason about deletes.

Ratings and favourites are not whole-state LWW, and cannot be.
Every other room field is whole-state last-write-wins keyed by `rev`; the
preference surface is not:

- two peers rating DIFFERENT recipes is the NORMAL case, not an edge
  case. Under whole-state LWW, whoever pushed last would erase every
  rating the other had cast. Household ratings are independent
  per-recipe opinions; clobbering them on every snapshot would lose peer
  edits constantly.
- so `applyRemote` reconciles **per record** (identical for `favorites`
  and `ratings`): for each incoming `[id, record]`, adopt it when we hold
  nothing for that recipe OR its `updatedAt` is strictly newer than
  ours; otherwise skip it untouched. Not a wholesale replace, and not a
  blind key-merge either — the timestamp test is what makes a replayed or
  out-of-order snapshot harmless, a later `{favorited: false}` un-stars
  for real, an older one is discarded, and an equal timestamp is not a
  new opinion (so the echo of our own push can neither resurrect a star
  nor inflate a count).

An incoming record is adopted **verbatim**, `count` included. That is
the only rule under which every peer holding the newest record for a
recipe agrees on it: incrementing on receive is not idempotent under
replay, so a re-rate would inflate the count and two devices would drift
apart on the very number the smoothing weighs. `count` therefore tracks
the votes known to the record — the author counts its own vote when it
writes, and a device changing its own mind never inflates it.

Inbound stamps are clamped to at most one hour AHEAD of our own clock
(`MAX_FUTURE_SKEW_MS`). Two phones on a LAN are seconds apart, but a
peer (or a hand-edited file) claiming a timestamp years ahead would
otherwise pin that recipe's rating forever — every later, honest write
looking "older". The clamp bounds that to one hour instead of never.

`SharedState.ratings` and `SharedState.favorites` are emitted **only
when non-empty** (the same conditional as `cookedHistory`): an absent
key means "nothing to merge", never "clear the household" — and a
v0.12.0 peer, which knows neither field, keeps its own state and is
otherwise unaffected (additive-only protocol, unchanged).

### 5. One push writer, two modes

Preference edits are **immediate** (no debounce): a star tap or a rating
is fire-and-forget household state — there is no burst to coalesce, and
the relay answers a rapid burst with `rate_limited`.

That does not mean a second push path. `schedulePush(immediate?)` stays
the single writer of `localRev`, with a single `applyingRemote` echo
guard and a single rev ladder; `immediate` only skips the 300ms timer.
Plan/grocery edits keep the debounce (a burst of taps must coalesce),
preference edits pass `true` and go out at once. One mechanism, two
modes, and an inbound snapshot can never bounce back in either.

A consequence worth stating: a joiner that ADOPTED the room's snapshot
(ADR-0028: an adopting join publishes nothing, so a peer's in-flight edit
is not frozen out) contributes its preferences on its NEXT edit. That is
accepted for now — merge/reconcile state converges anyway, and the seeded
favourites ride along with the first push it makes.

### 6. Auto-Plan consumes both, as weights only

- **Ratings** are blended by `useAutoPlan` into the score the planner
  already receives: `(stars/5 * count + mean * 1) / (count + 1)` over
  the ELIGIBLE slice's mean. The tiny prior (1, against the catalog
  smoothing prior of 10) is what makes one household 5-star outrank a
  crowd mean while the mean stays the cold-start floor. An UNRATED
  recipe keeps its ADR-0027 smoothed value bit for bit.
- **Favourites** are the new optional `favoriteIds` on `PackPlanRequest`
  and pay `FAVORITE_BONUS` (0.05) off a candidate's score — a fifth of
  a rating swing, a fiftieth of an opened package. It can flip a
  near-tie; it can never outvote waste. The rotating SEED is
  deliberately un-biased: it ranks on rating alone, so favourites nudge
  slot picking without moving which recipe anchors the pack.

With both fields absent, the planner is byte-for-byte v2, which is what
keeps the e2e pin `[17452, 6389, 9889, 6167]` meaningful.

### 7. Backup

`ratings.json` joins the `STORE_SLICES` registry (standing rule,
ADR-0013) as an ARRAY of `{id, rating, count, updatedAt}` rows — the id
travels with the record, and `updatedAt` is validated as a finite,
non-negative number. Import goes through the same validate-then-atomic
path as every other slice, and then applies the SAME per-record
reconciliation as the room: a backup written before a rating was cast
cannot roll that rating back. Ratings are therefore the one slice whose
import MERGES rather than replaces — a deliberate exception to the
"restore overwrites" promise, for the same reason it is one on the wire.
`favourites.json` is UNCHANGED: it still carries the materialized
`number[]`, never the tombstone records. A backup is a snapshot of what
you like, not a reconciliation log — shipping tombstones would leak
unreconciled state into every restore and bloat the slice for no
benefit.

## Known limitations (accepted, not accidental)

- **An older client can drop the fields from the room.** A v0.12.0 peer
  sends neither `favorites` nor `ratings`, and the relay replaces its
  whole stored snapshot on every push — so a push from an old peer
  leaves the room's snapshot without them. Receivers are protected (an
  absent field means "don't touch", so their local state survives), and
  a peer that has never heard of these fields keeps its own. What IS lost
  is the room's stored copy, which a device joining fresh would not
  receive. This is a property of the existing whole-snapshot protocol
  and applies equally to `cleared` and `customs`; fixing it means
  per-field versioning in the relay, well beyond this change.
- **Un-stars do not survive a reload.** Tombstones are in-memory only
  (the persisted format and the backup file are the starred id array, by
  the phase constraint), so a device that reloads holds its stars again
  and could re-adopt them from a stale peer push. Closing this means
  persisting records, which the constraint holds fixed for now.
- **The Auto-Plan pin proves less than it once did.** A fresh profile
  already holds the seeded favourites, so `runAutoPlan` always passes
  `favoriteIds`; the e2e pin now proves the SEEDED case is unchanged
  rather than the "no preferences at all" case. The "absent field == v2
  bit for bit" contract is pinned by unit spec instead
  (`packPlanner.test.ts`).

## Consequences

- Stars and ratings are now household state; a second phone in the room
  sees them live, and a restore carries them. Ratings converge by
  timestamp, so a replayed or out-of-order snapshot cannot undo a newer
  opinion.
- The Quick-Filters split (ADR-0028) still holds: the favourites SET is
  shared, the `favOnly` VIEW switch stays personal — sharing the switch
  would blank a peer's Recipes tab.
- Un-starring propagates, and cannot be undone by a stale push (§1).
- Auto-Plan output for a household that has rated or starred something
  is no longer pinned; the pin only constrains the pristine case.
