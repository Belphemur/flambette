# ADR-0090: the pantry becomes household state — room-synced like custom ingredients

Status: accepted (2026-10-14)

Implements the owner's directive on PR #92. The number 0090 was taken via
`scripts/build_adr_index.py --next` after a whole-remote-branch
reservation scan (only PR #92 open, no reserved numbers).

## Context

ADR-0087 Decision 7 ruled the pantry **device-local**: "In my kitchen" is
one member's kitchen, not household data — the same ruling ADR-0012
originally applied to custom ingredients. The pantry shipped that way in
PR #90: a persisted Pinia slice (`mealime-planner:v1:pantry`), registered
in `STORE_SLICES` (ADR-0013), absent from the room-sync payload.

ADR-0012's custom-ingredient ruling has since been reversed by owner
decision (the 2026 policy change recorded on `customs` in `SharedState`):
remembered ingredient names are HOUSEHOLD state. The pantry is the same
kind of fact — what the kitchen currently has is a property of the
household's shared kitchen, not of one phone — and keeping it device-local
means a second household member planning on another device plans against a
kitchen list they cannot see or fix.

## Decision

The pantry joins the room sync as the TWELFTH synchronized store, exactly
the way `customs` already does:

1. **`pantry` is a `SharedState` key** — `pantry?: PantryIngredient[]`,
   OPTIONAL under the standing additive-payload rule (ADR-0012): an older
   peer sends no key and keeps its own; absence means "don't touch",
   NEVER a wipe. Rows on the wire are the normalized `{name, nameKey}`
   pairs.
2. **Whole-state LWW under the room `rev`**, not per-key reconcile: the
   pantry is a small curated set edited one row at a time on one device at
   a time — the `favorites`/`ratings` record-and-tombstone machinery buys
   nothing here. The receiver funnels the payload through
   `normalizePantryRows` (the ONE row-normalization funnel), so a stale or
   hand-edited `nameKey` from a buggy peer can never make a chip display
   one ingredient while matching another — keys are re-derived from
   `name`, always.
3. **The payload is capped at `PANTRY_CAP` (500 rows)** — the store cap
   doubles as the payload cap.
4. **Per-store storage** rides ADR-0088's machinery untouched:
   `store_pantry` on both runtimes via migration 003 of the folder-shaped
   migration engine (`server/relay-core/migrations/003_pantry.ts`), and
   `pantry` added to `SYNCED_STORES` / `SHARED_STATE_KEYS` — split, merge
   and write-planner behavior follow the vocabulary automatically
   (ADR-0040 DRY).
5. **Backup slice unchanged**: the pantry keeps its ADR-0013
   `STORE_SLICES` registration; local-only devices (never in a room) keep
   exactly the device-local behaviour they had.

This supersedes ADR-0087 **Decision 7 only** — every other ADR-0087
decision (surface, suggestion machinery, ranking, categories) stands.

## Consequences

- A second household member sees and edits the same pantry; the Recipes
  tab's "in my kitchen" filter and ranking are household-wide.
- Leaving a room does not wipe the local list (absence = don't-touch; a
  departed device keeps its last-known pantry until it edits it).
- A device joining a room whose stored snapshot predates the pantry
  store keeps its local list and teaches the room the list on the
  household's NEXT GENUINE EDIT — not on adoption. A post-adoption
  reconcile push was considered and REJECTED (kody, PR #92 review):
  every push re-sends the whole LWW state (the relay preserves only
  `cookedHistory`/`planIdentity` when absent, so a pantry-only partial
  frame would fan out to older peers as `plan: undefined` — which their
  `state.plan ?? []` applies as a wipe), and an unchanged-content push
  at `maxSeenRev + 1` races a peer's in-flight edit at the same rev —
  the household freeze the join-echo rule exists to prevent. The pantry
  is convenience state (the local list drives the device's UI
  regardless of sync), so the bounded sync latency is the accepted
  trade.
- `docs/agents/rooms-and-sync.md`'s key list and the ADR-0088 store count
  (eleven → twelve) move in the same change as the code.

## Alternatives considered

- **Amend ADR-0087's Decision 7 in place** — rejected: this REVERSES an
  accepted decision, which the ADR records skill files as a new record,
  not an in-place rewrite.
- **Per-key reconcile with tombstones** (the ratings shape) — rejected:
  no delete-marker semantics needed for a 500-row set with a single
  writer at a time; whole-state LWW is simpler and already the `customs`
  precedent.