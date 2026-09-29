# ADR-0024: Auto-Plan — generating a meal plan from the frozen catalog

**Status:** Shipped (2026-09-29) — planner `src/lib/packPlanner.ts`, wired
through `src/composables/useAutoPlan.ts` + the Plan tab. Known deviation
recorded in **Shipment notes** below.
**Extends:** ADR-0003 (derived grocery merge keys), ADR-0017 (container
units), ADR-0018 (diet rules), ADR-0022 (measured amounts). No catalog data
changes.

## Context

The most-requested feature from r/mealime users asking for a replacement is
the thing the app still lacks: **"I want 4 meals for this week"**. Two
independent top comments describe it — *"be able to trust they were going to
be good"* and *"pick a meal I knew I wanted and then ask for 3 other
meals."*

Everything in the app is currently manual: the plan is built one recipe at a
time. Mealime's actual differentiator was not the recipe library (everyone
has that) but the plan you did not have to think about.

Two constraints make the obvious approaches wrong:

- **The catalog is frozen and offline.** 2,730 recipes, no network at
  runtime (e2e-enforced). There is no "chef updates this weekly" pipeline,
  so the generator must derive quality from data we already have.
- **The community explicitly refuses AI.** Several commenters made "no AI
  features" a condition of using the app. This rules out an LLM planner
  outright, and rules it out *by principle*, not just by preference.

## Decision

1. **A deterministic pack builder, not a model.** Greedy graph packing over
   the ingredient-overlap graph: pick a seed, then repeatedly add the
   candidate that minimizes marginal package cost. Waste-first, ratings as
   tiebreak. No inference, fully reproducible, unit-testable, e2e-pinnable —
   the same posture as every other pure lib in `src/lib/`.

2. **The unit of waste is the PACKAGE, not the gram.** This is the single
   most important modelling decision, and it only works because ADR-0017
   already classifies quantities into container vs linear. Two recipes both
   needing `1 ½ (142 g) pkg` can share ONE package. Two recipes both needing
   `2 cloves garlic` share nothing — you buy 4 cloves either way. Scoring on
   raw ingredient counts would treat a salt pinch and a cabbage identically
   and produce plans that save nothing.

3. **Pantry staples are excluded from the score.** `salt`, `black pepper`,
   `olive oil` and friends appear in 2,470 of 2,730 recipes; a pack that
   merely repeats them is not a waste win. They are marked present-but-free
   so they neither inflate nor deflate overlap.

4. **A precomputed index, not runtime fetches.** Answering "which recipes
   share ingredients?" needs every recipe's line items. Fetching 2,730 docs
   at plan time is ~15 MB; the docs are already lazy for good reason.
   `scripts/build_pack_index.py` emits `public/data/pack_index.json`
   (~540 KB raw / ~73 KB gzip) with ingredient nameKeys and unit strings
   interned into two string tables (338 and 53 distinct values).
   Recipe metadata is deliberately NOT duplicated — it already ships in
   `builder_data.json`.

5. **The Python builder is gated against the TypeScript it mirrors.** Every
   quantity rule is ported from `src/lib/containers.ts` and
   `src/lib/quantity.ts`, so the index can silently drift from the grocery
   list it must agree with. `scripts/verify_pack_index_parity.ts` replays all
   34,415 line items through the real TS functions and fails the build on any
   divergence. Run `bun run data:verify` before committing either side.

6. **Plans are flat lists, never day-scheduled.** Both top commenters named
   unassigned meals as a feature: you decide what to cook tonight. The
   generator emits a set; it does not build a calendar.

## Measured, not assumed

Prototype over the full catalog, 4-meal packs, 60 runs vs 400 random:

| | packages bought | non-pantry ingredients |
| --- | --- | --- |
| random 4-meal plan | 4.04 | 20.4 |
| greedy waste-first | 0.25 | 15.2 |

-94% packages, -25% distinct ingredients, ~5 ms per plan in Python (JS will be
faster). The index loads in under 100 KB gzipped, so the feature is
essentially free at first paint.

## Alternatives considered

- **LLM planner.** Rejected twice over: it breaks the community's explicit
  "no AI" condition, and it would need the network the app deliberately does
  not have.
- **Score on raw ingredient-name overlap** (no container distinction).
  Rejected: measures the wrong thing, as in (2) above.
- **Precompute an index of pre-scored *combinations*.** Rejected: the
  combination space is C(2730,4) ≈ 1.4×10¹¹. An index that cannot be
  enumerated is not an index.
- **zstd or brotli for the index.** Rejected: zstd-19 saves ~15 KB and
  brotli-11 ~8 KB over stock gzip, neither of which justifies changing the
  nginx base image for a file this small. Measured; the answer was "no".
- **Ask the user to pick the objective** (waste vs speed vs variety). Deferred
  to a post-v1 settings toggle; v1 ships waste-first because that is what the
  thread asked for and what the container model actually measures well.

## Consequences

- The app gains the one feature it was missing, and it is deterministic
  enough to pin in e2e: same inputs, same plan, every time.
- A wrong plan is debuggable — it is a scoring function, not a black box.
- The parity harness is a permanent tax on the data layer, paid back every
  time `containers.ts` changes without the Python being updated.
- ADR-0017's container model stops being a grocery-list detail and becomes
  load-bearing for planning. Changing `CONTAINER_NOUNS` now changes plans.

## Shipment notes (phase 19)

Deviations from the original sketch, each justified:

- **No `category` field in the request.** The committed index carries no
  category (it deliberately duplicates no builder_data metadata), so the
  planner takes `excludeIds` only; `useAutoPlan` resolves the category
  constraint, active diet chips (ADR-0018) and already-planned meals into
  that set. The brief's fallback branch ("caller assembles the eligible id
  set from builder_data") is what shipped.
- **`ratings` ride on the request.** Same reason: the index has no recipe
  metadata, so `PackPlanRequest.ratings` (Map variant id → rating) is
  injected by the caller from `builder_data.variant_meta`.
- **Measured packages differ from the prototype table.** The 0.25-vs-4.04
  numbers above were measured with a different notion of "package" than the
  shipped `Σ ceil(container total)` metric (the prototype merged the same
  container across ingredients). On the shipped metric, measured live:
  random 4-meal plan ≈ 19.1 packages, greedy waste-first ≈ 8, single-recipe
  baseline ≈ 4.85/package-per-meal — a ~58 % package reduction, not the
  prototype's -94 %. The greedy algorithm and scoring formula are unchanged;
  only the table's unit definition was wrong.
- **Relay: per-IP throttle budgets now key on the REAL peer address.**
  `Server.requestIP(ws)` requires a Request object — called with a
  ServerWebSocket it throws, so the throttle's `safeAddress` fallback
  collapsed EVERY peer into the single `ip:unknown` bucket (30 attempts /
  60 s shared across the whole suite). Late-suite room joins then got
  `rate_limited` and their "Live" chip never appeared — CI showed 4 such
  failures (local CI-mode: 9). Causally pinned: raising
  `RELAY_ATTEMPT_LIMIT` made all 224 e2e pass. Fix (relay.mjs only —
  `server/throttle.mjs` stays canonical): capture the IP at upgrade time
  (`srv.requestIP(req)` inside fetch, where `req` IS a Request) into
  `ws.data.ip` and key budgets on it. Same fix also restores the per-IP
  half of the brute-force throttle, which could never distinguish IPs
  under the fallback.
- **Toast actions take an optional `testId`** (`stores/ui.ts`) so the undo
  affordance can carry `data-test="auto-plan-undo"` without changing the
  generic `toast-action-primary/secondary` contract.

E2E pins (fresh profile, no diet chips, any protein): seed + 3 picks →
`[4908, 6185, 6729, 12069]` (`e2e/auto-plan.spec.ts`).
