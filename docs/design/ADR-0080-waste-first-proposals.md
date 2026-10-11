# ADR-0080: Auto-Plan proposals — waste-first ranking and the continuity seed

**Status:** Accepted (2026-10-11).
**Extends:** ADR-0024 (the pack builder) and ADR-0027 (v2 selection policy) —
the index, the container model, the score arithmetic and the determinism
posture are unchanged and stay in force. ADR-0031's favourite bonus rides
along unchanged.
**Supersedes (in part):** ADR-0033 — a Regenerate press still rolls, but what
it rolls is the PROPOSAL WINDOW, not a single blind seed (§Decision 4).

## Context

The Mealime shutdown thread (r/mealime, Oct 2026) names the two features
users most want preserved: plans generated FOR you that you can pick from
and swap ("they give you a few to choose from"), and plans that optimise
ingredients ("I don't want a shopping list that's ½ head cauliflower, ½ head
romaine"). Flambette has the second structurally (ADR-0017 + ADR-0024) and
the first partially — one pack per press. Owner direction for this record:
**waste first, then rating, then favourite** — and keep the seed rotation as
the variety mechanism, with the plan's own "usual ingredients" anchoring a
replacement flow.

Measured against the real `pack_index.json` (dinner pool = 2,119 recipes,
Bayesian-smoothed ratings as `useAutoPlan` injects them):

1. **The greedy core is strong.** The default gen-0 4-pack buys 8 packages
   vs a random-4-pack median of 20 (beats 98.8% of 3,000 sampled random
   packs); package utilization 97% vs a 90% random mean.
2. **The seed pick is waste-blind — and it is the biggest waste lever.**
   The first meal is chosen by smoothed rating alone; the greedy slots can
   only SHARE its footprint, never avoid it. Across the real top-5 rotation
   the packs span **4 / 5 / 6 / 8 / 8 packages** — same meal count, 2× the
   waste — and the DEFAULT press (highest-rated seed, `#17452`) is the
   WORST: its anchor alone (`broccoli×3, tuna×3, cream cheese×1,
   cheddar×0.75`) accounts for all 8 packages. The preview prints
   `packagesBought`, so households can see this.
3. **The waste floor is 4 packages and nearly every seed reaches it.** A
   brute force over all 2,119 dinner seeds (12.9 s): distribution
   `4:2115, 5:1, 6:1, 8:2` — the two 8-package packs come exactly from the
   two highest-rated seeds. The rating-ranked anchor is what stands between
   the default plan and the floor.
4. **Metric boundary (known, unchanged):** the ledger sees purchasable
   CONTAINERS only (ADR-0017). 101/2,119 dinner recipes (5%) have zero
   container rows and read as free — swapping the 8-package anchor for one
   such recipe "drops" the pack to 0 packages while shipping the same
   unseen produce waste. Count/weight ingredients are invisible. This
   record works WITHIN the metric; extending it is future work (§Rejected).

## Decision (owner-binding)

1. **Ranking order — waste, then rating, then favourite.** Proposals are
   ranked by `packagesBought` ascending, then anchor smoothed rating
   descending, then anchor id ascending. The favourite bonus stays INSIDE
   the per-slot scores (ADR-0031, 0.05); it does not reorder proposals —
   a package is worth twenty favourites, exactly as a package is worth
   four rating swings today.
2. **Proposals, not a pack.** A new pure entry point
   `buildAutoPlanProposals(index, req): PackProposal[]` returns up to
   `PROPOSAL_COUNT = 3` DISTINCT packs. Each proposal is greedy-completed
   with today's v2 arithmetic over one candidate seed; the candidate seeds
   are the top-`ROTATION_K` (5) smoothed-rated candidates (ADR-0027 §5).
   `buildAutoPlan` itself is UNCHANGED — absent the new request field the
   lib is bit-for-bit v2, which keeps every existing unit pin valid (the
   same back-compat rule ADR-0027/0031 used).
3. **The continuity seed (add mode).** When the current plan pre-commits as
   `baseIds`, proposal #1's anchor is NOT a rating rank — it is the
   CONTINUITY SEED: the eligible candidate with the LOWEST marginal package
   cost against the base ledger (ties → smoothed rating desc → lower id).
   The ledger already holds what the household is buying; the anchor EXTENDS
   it instead of opening new packages. In the owner's words: check the
   usual ingredients used, use that as the first seed, then continue from
   there. The remaining proposals seed from the rating-ranked top-K as
   today. On an empty plan (replace mode) there is nothing to continue
   from, so all proposals come from the rating-ranked seeds.
4. **Regenerate rotates the proposal window.** The visible proposals are
   the window starting at rank `(generation mod (ROTATION_K − PROPOSAL_COUNT
   + 1))` of the rating-ranked seed list (add mode: the non-continuity
   seeds — the continuity seed is removed from the rated pool BEFORE the
   window start is taken, which makes the dedupe structural). Every press
   shows a different deterministic set; the continuity
   proposal stays pinned as #1 in add mode. For pools smaller than the
   window the start modulus clamps to the pool and the walk is CYCLIC, so
   every eligible seed stays reachable from every generation (a
   one-candidate pool at generation 2 shows its one proposal, never an
   empty preview). Per-generation determinism
   (ADR-0027's contract) is unchanged: same (index, request incl.
   generation) → identical proposal list. The `autoPlanGeneration` counter
   keeps its TWO advance points (ADR-0033).
5. **The dialog presents choices.** The Auto-Plan preview (ADR-0030) renders
   one card per proposal — meals, and its own "buys N packages" line — with
   the cheapest proposal PRE-SELECTED. Confirm applies only the selected
   proposal; add/replace semantics, undo, and the confirm-before-destroy
   flow are untouched. The selection is ephemeral view state (like the
   search query — never persisted, never room-synced, no STORE_SLICES
   change).
6. **No post-hoc swap polish.** A hill-climb over single swaps on the
   container-only metric is metric-gaming: it validated at 8→0 packages by
   swapping the anchor for a ZERO-container recipe — the same real-world
   groceries, an invisible ledger. Waste-first SELECTION (decisions 2–3)
   gets the default press to the floor without it. Extending the ledger to
   count-noun produce is the honest future fix and needs `pack_index.json`
   + parity work (`bun run data:verify`), so it is out of scope here.

## Measured, not assumed

- Default press (fresh profile, dinner, empty plan, generation 0): the
  pre-selected proposal becomes **`[13443, 6389, 11982, 6167]` — 4
  packages** (Lemon-Oregano Salmon…, gen-2's pack under the old rotation),
  down from 8. The e2e pins `PINNED_DEFAULT_IDS` in `e2e/auto-plan.spec.ts`
  and `e2e/household-ratings.spec.ts` re-pin to it — the loud break IS the
  contract working (ADR-0027 §Consequences).
- Proposal spread on that press: 4 / 5 / 6 packages from the remaining
  seeds (the two 8-package packs appear only when their seeds lead the
  window; the cheap one is always pre-selected).
- Cost: 5 greedy completions per generate. The 2,119-seed brute force ran
  12.9 s, so 5 seeds are ~30 ms — sub-frame, same posture as the memoized
  Regenerate path today.
- ADR-0033's complaint ("keeps giving the same meals") stays fixed: the
  window rotates every press, the household can also just pick a different
  proposal — which is precisely the Mealime behaviour the thread asks for.

## Consequences

- `useAutoPlan` calls `buildAutoPlanProposals` and returns proposals +
  `eligibleCount`; `AutoPlanDialog.vue` gains proposal cards and a
  selection model (new `data-test` hooks pinned by e2e).
- The two e2e pack pins change; unit pins on `buildAutoPlan` do NOT (the
  function is untouched).
- No new persisted state, no backup/room payload change (plan entries are
  unchanged).
- The plan store still has NO day/slot concept — cook-day adjacency
  ("same ingredient back-to-back days", the PlannyMeals pitch) remains
  future work; this record only fixes WHAT is picked, not WHEN it cooks.
- Known metric boundary stands: a 4-package pack can still hide
  zero-container waste; the ledger extension (count-nouns, pack-index
  parity) is the follow-up ADR if the grocery lists still read wrong.

## Alternatives considered

- **Status quo (rating-ranked single seed).** Rejected: the default press
  buys 2× the floor and the number is printed right in the preview.
- **Hard best-of-K — return only the min-package pack.** Rejected: it
  collapses the rotation (every generation returns the same pack) and
  re-opens the ADR-0033 complaint; proposals give the variety back as an
  explicit user choice.
- **Widen the seed search to all 2,119 candidates.** Rejected: 12.9 s per
  press is a dead dialog, for nothing — the brute force shows the top-5
  window already contains the floor and the ranking fix reaches it.
- **Bounded swap polish on the final pack.** Rejected (§Decision 6):
  optimises the metric, not the grocery bill, until the ledger itself
  widens.
- **Multi-proposal via re-running with different `seedGeneration`s
  caller-side.** Rejected: the lib owns selection policy (DRY — one
  scorer, one tie-break chain), and caller-side re-runs would re-fetch and
  re-smooth ratings per proposal.
