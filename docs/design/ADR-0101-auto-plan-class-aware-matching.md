# ADR-0101: Auto-Plan v4 — class-aware waste matching (meat first, produce second, leftover-fill)

**Status:** Accepted (2026-10-28).
**Extends:** ADR-0024 (the pack builder), ADR-0080 (waste-first proposals) and
ADR-0031 (favourites) — the proposal layer, the packages-asc ranking, the
continuity seed, the disjoint windows, the recency demotion and the favourite
bonus are unchanged and stay in force.
**Supersedes (in part):** [ADR-0027-auto-plan-v2](ADR-0027-auto-plan-v2.md) —
the slot score's waste term (uniform marginal package cost) is replaced by a
class-aware waste model with an ingredient-matching credit (§Decision 2–4).
Every other ADR-0027 decision (Bayesian smoothing, tag penalty, seed rotation,
determinism posture) stands.

## Context

Owner directive for the Auto-Plan generator: **"start by trying to match the
meat, then match the produce, and try to match what you already have — a
quarter package or things like that — to reduce the waste."** This is the
Phase-4 PRD promise ("Enhanced package waste optimizer") aimed at the one
place the current scorer is blind.

Measured against the real `pack_index.json` (2,760 recipes, 339 ingredient
keys, dinner pool 2,119 as ADR-0080):

1. **The container ledger cannot see most of the cart.** Of the index's
   1,720 meat rows only 100 (5.8%) are ADR-0017 containers; 1,620 are
   count/weight rows (`2 chicken breasts`, `500 g ground beef`) the ledger
   prices at zero. Produce: 3,887 of 11,436 rows are containers (34%).
   210 of 2,760 recipes carry zero container rows at all (ADR-0080 §4's
   known boundary). Weighting CONTAINER classes (the obvious reading of
   "match the meat") measured as a no-op: with meat packages weighted 2–3×,
   every measured pack is unchanged — because the candidates that matter
   compete at zero container marginal, where there are no meat packages to
   weight. The matching signal must reach the rows the ledger cannot price.
2. **"Opens no new package" is not "reduces waste".** The scorer treats a
   candidate that ignores a half-open package identically to one that
   consumes its remainder — both cost 0 marginal. The leftover of an
   already-bought package is real waste the metric never sees.
3. **The grocery list already merges what the planner ignores.** Two dinners
   sharing `chicken breasts, boneless skinles` buy ONE chicken purchase
   (ADR-0003 merge-by-nameKey); two dinners not sharing it buy two separate
   meat purchases even when each is container-free. Ingredient-key overlap
   IS the purchasable reality for count/weight rows — presence-based, like
   the tag term.

## Decision (owner-binding)

1. **Ingredient classes come from the ONE aisle table.** The planner imports
   `bucketFor` from `src/lib/sections.ts` (both are pure libs — no Vue, no
   fetch, no new dependency): `Meat & Seafood` → class 0, `Produce` →
   class 1, everything else → class 2. No `pack_index.json` change, no
   Python parity work, no `test:data` surface. The planner's "meat" is
   exactly the aisle the shopper walks (ADR-0076's department hues); one
   keyword table stays the single source (DRY). Measured classification of
   all 339 keys: 33 meat, 91 produce, 215 other; 5 meat-recall misses
   (`chicken or vegetable broth`, `fish sauce`, `anchovy fillets`, `raw
   peeled shrimp`, `graham cracker`) — acceptable: broth/fish sauce are
   canned goods, and the misses only cost those keys their match credit.
2. **Match credit — the new slot term.** A candidate earns credit for each
   of its NON-container, non-pantry rows whose ingredient key is already
   committed in the ledger (base meals included): `MEAT_MATCH = 0.5` per
   shared class-0 key, `PRODUCE_MATCH = 0.25` per shared class-1 key,
   `OTHER_MATCH = 0.05` per shared class-2 key. Presence-based (amount
   does not matter — the catalog does not state purchase units for count
   rows), mirroring the tag term's shape. Meat-first ordering: one shared
   meat key outweighs one shared produce key two-to-one.
3. **Leftover-fill credit — the quarter-package match.** For each committed
   container whose running total has a remainder (`ceil(total) > total`),
   a candidate that consumes part of it earns `FILL_WEIGHT = 0.25` ×
   `min(need, remainder)`. A ¼-opened feta package matched by a ¾-using
   candidate now outranks a candidate that ignores it at equal marginal
   cost; any excess beyond the remainder crosses the ceil and shows in the
   marginal term as today.
4. **Waste-first cap.** The candidate's total credit (match + fill) is
   capped at `CREDIT_CAP = 0.9` — strictly below one package. The invariant:
   **a candidate that opens a new package can never outrank a zero-marginal
   candidate on matching credit alone.** ADR-0080 Decision 1 (waste first,
   then rating, then favourite) is preserved exactly; matching reorders
   candidates WITHIN a package tier, never across one.
5. **The slot score becomes:**
   `marginalPackages − credit + 0.25·(1−rating) + 0.2·tagOverlap − 0.05·fav`
   — same shape as ADR-0027 §4 with the credit subtracted. **Unchanged:**
   the proposal ranking (`packagesBought` ASC → seed rating DESC → id ASC),
   the printed `packagesBought` definition, the continuity seed (lowest
   container marginal, rating tie-break, ROTATION_K rotation), the disjoint
   windows, the pack dedupe, the recency demotion, `PROPOSAL_COUNT`/pool
   sizes. `buildAutoPlan` shares the scorer (one scorer, never forked).
6. **This scoring change is unconditional — no opt-in field.** Prior
   amendments (ADR-0027/0031/0080) kept bit-for-bit back-compat by gating
   new behaviour behind absent request fields. This record REDEFINES the
   waste model itself, which is the owner's directive; the back-compat rule
   does not apply. The e2e pack pins break loudly and are re-pinned — that
   is the pin contract working (ADR-0027 §Consequences).

## Measured, not assumed

Prototype = faithful Python port of the current planner, verified by
reproducing the exact gen-0 e2e pin `[13443, 6389, 11982, 6167]` (4
packages) including the proposal layer, tags and smoothing; then rerun with
§Decision 2–4 (weights 0.5/0.25/0.05, fill 0.25, cap 0.9):

- **Gen-0 default press (fresh profile, dinner, replace on empty):**
  pre-selected pack becomes **`[13443, 5451, 4988, 6389]` — still 4
  packages**, now three salmon dinners + chicken katsu sharing one salmon
  purchase (distinct committed non-container keys shared by ≥2 meals:
  7 → 8; distinct proteins 3 → 2). The weight grid 0.5–1.0 meat / 0.25–0.5
  produce produced the same pack shape at every scale; the UNcapped variant
  collapsed to a single-protein pack (proteins 1) — the cap is what keeps
  variety in the pack while matching.
- **Generations 1–2:** pre-selected packs stay 4 packages with 2 proteins
  and shared-key counts of 10 (vs 4–6 packages, same packagesBought, under
  the current scorer). Matching never costs a package in any measured
  scenario.
- **Add mode (base = the pinned 4-pack, +2 meals):** the second addition
  moves from a strip-steak dinner (its meat purchase invisible to the
  ledger) to a chicken-breast dinner sharing the base pack's chicken —
  shared keys 9 → 11, packages still 4.
- The printed metric is honest: `packagesBought` is unchanged by design and
  the credit never moves it across a package tier (§Decision 4).

## Consequences

- `src/lib/packPlanner.ts` gains the class table import and the credit
  computation inside the slot scan; the ledger already tracks committed
  keys (`scored`) — the match term reads it, container remainders read
  `totals`. Unit pins on the old score arithmetic are updated, not weakened.
- e2e: `PINNED_DEFAULT_IDS` in `e2e/auto-plan.spec.ts` and the
  `household-ratings.spec.ts` re-pin to the new gen-0 pack — prototype-
  predicted `[13443, 5451, 4988, 6389]`; the PR pins whatever the real
  planner emits and reconciles any divergence against the prototype in the
  PR body. New pins: add-mode matching (a +2 continuation prefers a recipe
  sharing a base protein over one opening an invisible new meat purchase).
- `docs/agents/auto-plan.md` updates the score formula and the class table
  in the SAME change as the implementation (the topic file is part of the
  contract). No PRD divergence — this IS the Phase-4 optimizer.
- No persisted state, backup, room-payload or `pack_index.json` change; no
  new dependency; classification runs at request time over 339 interned
  keys (trivial cost, same posture as the memoized planner).
- Known boundary, now narrower: the ledger still prices packages, not
  grams; the match credit is a proxy for purchase-sharing on count/weight
  rows, not a purchasable-unit model for them (that remains future work —
  ADR-0080 §Rejected's ledger extension).

## Alternatives considered

- **Weight the container classes (meat packages cost more).** Measured
  no-op: candidates compete at zero container marginal where meat packages
  do not exist; 94% of meat rows are invisible to that term.
- **Extend the ledger to purchasable units for count/weight rows** (the
  ADR-0080 §Rejected future work). Rejected for now: the catalog does not
  state what a chicken-breast package is; inventing purchase units per
  ingredient is unfalsifiable and needs `pack_index.json` + parity work.
  Presence-based matching delivers the owner's behaviour without it.
- **Lexicographic matching (minimize meat packages, then produce, then
  rest).** Rejected: lexicographic greedy starves later slots (a
  meat-perfect first pick can force three new produce packages) and
  breaks the single-score tie-break chain ADR-0027 established.
- **Match credit on container rows too.** Rejected: container sharing is
  already priced by the marginal term; double-counting would over-reward
  candidates that happen to share a large container.
- **Apply the match credit to the continuity seed's tie set.** Rejected
  for now: the continuity contract (ADR-0080 Decision 3 + tie-rotation
  amendment) is pinned and its rotation is the variety mechanism there;
  the slot credit already delivers "match what you already have" to the
  completed pack.
