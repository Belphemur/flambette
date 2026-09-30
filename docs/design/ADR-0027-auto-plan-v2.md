# ADR-0027: Auto-Plan v2 — variety-aware completion planning

**Status:** Accepted (2026-09-29).
**Extends:** ADR-0024 (the pack builder) — this record changes the SELECTION
POLICY and the default interaction; ADR-0024's index, container model and
determinism posture are unchanged and stay in force.

## Context — the owner complaint

"Auto-Plan keeps giving me the same meals." Verified against the data, three
root causes:

1. **Raw ratings are noisy.** Seed/score used the raw `rating` field: a 1.00
   from 1–2 votes outranks a 0.95 from hundreds. The phase-19 pinned pack
   `[4908, 6185, 6729, 12069]` is literally three 1.00-rated recipes with
   `rating_count` 2, 3 and 1.
2. **Waste-first rewards similarity.** Two lamb dishes share ingredients →
   low marginal cost → picked together. `variety_tag_ids` exists in
   `builder_data.variant_meta` and was unused.
3. **No meal-type control.** The pinned pack contained a DESSERT
   (`12069`, `ruleset=dessert`); `ruleset` was unused by eligibility.

## Decision (owner-binding)

1. **Addition, not replacement.** Auto-Plan's default mode COMPLETES the
   current plan: meals already planned become `baseIds` whose footprints
   pre-commit into the waste ledger — the planner chooses new meals that
   reuse what the user is already buying. Base meals never appear in
   `variantIds`, are never re-picked, and `packagesBought` /
   `scoredIngredients` describe the FULL pack (base + additions).
   Replacement stays available (confirm-before-destroy + undo exactly as in
   phase 19), but add is the DEFAULT. Undo restores the exact prior plan
   (entries AND cleared-ingredient map) in BOTH modes.
2. **Ruleset is a per-run selector.** Dinner (default) / Breakfast / Dessert
   / Any, resolved caller-side against `variant_meta.ruleset`; the choice is
   persisted (`ui.autoPlanRuleset`). 'Any' imposes no filter.
3. **Rating smoothing (Bayesian shrinkage).** The caller injects
   `smoothed = (rating·count + mean·10) / (count + 10)` per candidate, with
   the mean taken over the ELIGIBLE slice (a dessert-only run is not dragged
   by 2,090 dinners). Prior weight 10: one new vote moves a recipe's score
   by ≤ 1/11 of the distance to the mean — enough to drown the 2-vote 1.0s
   (2 votes shrink a 1.0 to `mean + 0.9·(1.0−mean)`) without flattening the
   hundreds-of-votes recipes the data already ranks confidently.
4. **Variety-tag penalty.** Score becomes
   `marginalPackages + 0.25·(1−rating) + 0.2·tagOverlap` where tagOverlap is
   the candidate's tags already present on picked meals (base included).
   **TAG_WEIGHT = 0.2**: meaningfully less than a full rating swing (0.25)
   and far less than one opened package (1.0) — similarity nudges ties,
   waste still decides. No tags map → v1 behavior (back-compat for old
   callers/tests).
5. **Rotating seed.** Candidates ranked by smoothed rating desc (ties →
   lower id); seed = rank `(generation mod 5)`. Generation 0 reproduces the
   "highest smoothed rating" seed exactly. Generation 0's top-5 come from
   real vote-backed recipes now, so rotation is between plausible seeds, not
   noise. The counter (`ui.autoPlanGeneration`) increments after every
   successful apply and is persisted/carried in backups.

## Determinism contract v2

Same (index, request incl. `seedGeneration`) → identical output object. The
generation is part of the request, so "different seed each run" is
deterministic per generation — pinned in e2e (rotation stability test).

## What did NOT change

- `public/data/pack_index.json`: same schema, not regenerated,
  `bun run data:verify` green untouched. Tags and ratings are injected at
  runtime from `builder_data` — same rule as phase 19.
- The packer's waste model (packages, pantry-free, ceil-merge) — ADR-0024
  §Decision 2/3 and the parity harness are untouched.
- Room payload shape: plan entries are unchanged, so `{plan, ...}` syncs
  exactly as before.

## Measured, not assumed

- New default pin (fresh profile, dinner, add-on-empty, generation 0):
  `[17452, 6389, 9889, 6167]` — `rating_count` 23/10/149/32 (phase-19's was
  2/3/1/x), all four ruleset `dinner` (the dessert is gone), four distinct
  tag sets.
- Successive generations change the seed (e2e rotation test) while each
  generation stays stable — the "same meals every time" complaint breaks
  without giving up reproducibility.

## Consequences

- The persisted-ui slice grows three fields (`autoPlanRuleset`,
  `autoPlanMode`, `autoPlanGeneration`) — registered in STORE_SLICES
  (ADR-0013 standing rule) with backup round-trip unit + e2e coverage.
- The lib stays pure: base/tags/generation ride on `PackPlanRequest`.
- The old e2e pin breaks loudly — that is the contract working as intended.
