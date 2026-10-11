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

## Presentation amendment (2026-10-11, owner ruling after the Stitch render)

The first implementation rendered the proposals as stacked rows titled
"Option 1/2/3". Owner review of the Stitch renders
("Flambette — Auto-Plan Proposal Chooser", screens
`e602d8dba75142a0b8e144e63db31e3d` (mobile) and
`9d996775280e40e9a5d591e1937ab8e0` (desktop), project 2725470430841257407)
ruled the chooser must LOOK like a choice between plans:

- **A "Choose your plan" section header** with the explicit line
  "We generated 3 plans for your week. Tap one to preview it — the badge
  marks the one that buys the fewest packages." (desktop: "Pick one").
  The multiple-options fact is STATED, never implied.
- **Plan letters, not ordinals**: cards are "Plan A / Plan B / Plan C"
  in ranked order, each with a RADIO INDICATOR (filled tomato dot when
  selected) so the affordance reads as pick-one-of-N.
- **The cheapest card carries a "FEWEST PACKAGES" pill** (tomato tint,
  tomato text) — Decision 1's pre-selection made scannable. The selection
  state stays the tint + 2px tomato border; the pill is metadata, not
  state.
- The continuity marker ("extends your plan", Decision 3) renders as a
  second pill beside FEWEST PACKAGES when the card is the continuity
  proposal.
- Everything else in Decision 5 stands: radio-group semantics with
  arrow-key roving focus, per-card `buys N packages` in the mono data
  voice, ephemeral selection, Confirm applies only the selected card.
  Accessible names carry the plan letter (`Plan A: 4 meals, buys 4
  packages`); any e2e assertion pinned to the old "Option N" phrasing
  re-pins.

## Regeneration-variety amendment (2026-10-11, owner bug report #74)

"Plan A never changes when I press Regenerate." Measured, both modes:

- **Replace mode:** the ranking collapses the rotation. Seed #13443 (rank 2
  of the top-5) sits inside EVERY 3-wide window of a 5-seed pool, and
  Decision 1 re-sorts by packages — its 4-package pack wins Plan A at every
  generation (gens 0–6 identical). Only B/C rotate.
- **Add mode:** the continuity seed is deterministic per base ledger, and
  the minimal-marginal tie set is HUGE — 101 candidates tie at 0 marginal
  cost against a 4-meal base. The rating tie-break pins #9889 forever.

Regenerate must visibly change the pre-selected plan (ADR-0033's contract,
which this ADR inherited). Decisions (owner-binding):

1. **Continuity tie-rotation.** The continuity seed is the candidate at
   rank `(seedGeneration mod min(tieCount, ROTATION_K))` of the
   minimal-marginal tie set ordered by smoothed rating desc → id asc.
   Rank 0 = today's pick, so generation 0 output is UNCHANGED and the
   pinned pack survives. The proposal keeps `kind: 'continuity'` and the
   EXTENDS YOUR PLAN pill — it still extends the plan at the same (zero)
   marginal cost; WHICH tied candidate leads rotates.
2. **Disjoint proposal windows.** The proposal seed pool widens to
   `PROPOSAL_POOL = PROPOSAL_COUNT × 3` (9) top-rated candidates; window
   `w = seedGeneration mod 3` covers ranks `[3w, 3w+2]`. Windows never
   overlap, so the cheapest pack of one window cannot dominate the next
   generation. Generation 0 covers ranks 0–2 = today's set exactly (pin
   survives). Cost: 9 planner completions instead of 5 — measured
   sub-frame (~50 ms).
3. **Pack-content dedupe.** Distinct seeds can complete to the SAME
   variantId set (measured: eight seeds → the identical 4-package pack).
   Within one proposal set, a candidate whose pack equals an already-chosen
   proposal's pack is skipped and the next ranked seed takes the slot; if
   the pool exhausts, fewer cards render (never a duplicate card). The
   window advance walks RANKS; the dedupe skips SEEDS already TAKEN, it
   does not skip packs seen in other generations (no cross-generation
   state — determinism per generation is preserved).
4. e2e: the gen-0 pins stand (both amendments keep generation 0
   bit-for-bit). New pins: Plan A differs across generations 0/1/2 in
   replace mode, and across two consecutive Regenerates in add mode with a
   non-empty plan.

## Recency-demotion amendment (2026-10-11, owner refinement of #74)

"Mostly the same recipes coming out, instead of widely different ones."
The regeneration-variety amendment fixed WHICH SEEDS lead the window, but
the top-rated candidates still recur across presses — nothing remembers
what was already shown. Owner direction: regenerate acts like a QUEUE —
"putting the current recipe at the end of the choice available, like a
blacklist for the current auto plan" — refined by a follow-up owner
ruling: NO persisted store. The offered-set memory is EPHEMERAL, part of
the regenerate run happening in the open dialog; nothing lands in
localStorage, backup, or the room payload. Decision (owner-binding):

1. **Offered-set demotion, held by the dialog.** While the Auto-Plan
   dialog is open, the component accumulates `offeredIds` — the union of
   every variantId shown in proposal cards so far this dialog session
   (each generate press adds its three proposals' ids). Every press passes
   the set into the planner request as `offeredIds`. Closing the dialog
   discards it — the next open starts clean, exactly like `pendingProposals`
   today. NO persisted store, NO STORE_SLICES change, NO backup/room
   payload change (the same ephemerality rule as the proposal selection,
   Decision 5).
2. **Demotion, not deletion.** A candidate in `offeredIds` stays eligible;
   it only ranks BEHIND every not-yet-offered candidate (relative order
   among demoted candidates preserved: smoothed rating desc → id asc).
   Within one regenerate press the planner may still re-offer a demoted
   candidate when the fresh pool cannot fill three DISTINCT packs —
   variety yields to availability, waste stays king.
3. **Ranking composition.** Candidate ranking for the proposal pool
   becomes: (not offered first, then) smoothed rating desc → id asc.
   Everything downstream (the 9-candidate pool slice, windows, continuity
   tie-set, pack dedupe, packages-asc proposal ranking) is UNCHANGED —
   demotion only reorders the CANDIDATE pool before the pool slice.
4. **Determinism.** `offeredIds` is part of the REQUEST: same (index,
   request incl. generation + offeredIds) → identical output. A dialog's
   FIRST press passes an empty set, so generation 0 output is bit-for-bit
   the pinned pack — all existing e2e pins stand. Regenerate presses
   differ from each other BY CONSTRUCTION (the offered set grows), which
   is what the owner asked for.
5. **Dialog copy.** The chooser's supporting line gains the rotation fact:
   plans you've seen move to the back of the queue ("Regenerating shows
   plans you haven't seen yet"). One sentence, muted text.
6. e2e: within one dialog session, two consecutive Regenerates produce
   pre-selected plans sharing NO meals (fresh profile, replace mode);
   re-opening the dialog resets the memory (first press reproduces the
   gen-0 pin); the gen-0 pin itself still passes.

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
