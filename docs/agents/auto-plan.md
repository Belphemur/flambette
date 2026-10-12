# Auto-Plan (ADR-0024 → ADR-0080)

The plan generator is `src/lib/packPlanner.ts` — a PURE lib (no
Vue/Pinia/fetch) over the committed `public/data/pack_index.json`
footprint. Deterministic greedy packing: score = marginal whole-package
cost (`Σ ceil(container total)`, containers per ADR-0017)
`+ 0.25·(1−rating) + 0.2·tagOverlap − 0.05·isFavourite`. Staples in the
index's `pantryStaples` are present-but-free. Category / diet / ruleset
exclusions are resolved OUTSIDE the lib by `useAutoPlan` into
`excludeIds`. The index carries no recipe metadata — ratings and
`variety_tag_ids` are injected from `builder_data.variant_meta`.

## v3 — proposals (ADR-0080, the current contract)

`buildAutoPlanProposals(index, req)` returns up to 3 DISTINCT packs; the
Auto-Plan dialog renders one card per proposal ("Choose your plan", Plan
A/B/C radio cards, FEWEST PACKAGES pill on the cheapest) and applies ONLY
the selected one. Ranking is packages asc → seed rating desc → seed id
asc — waste first, then rating, then favourite (owner-binding order).

- **`buildAutoPlan` is UNCHANGED** (bit-for-bit v2) — absent the
  proposal entry point, old callers/tests are valid.
- **Continuity seed (add mode)**: when the current plan pre-commits as
  `baseIds`, one proposal anchors on the eligible candidate with the
  LOWEST marginal package cost against the base ledger (ties → rating
  desc → id), rotating within its tie set by
  `(generation mod min(tieCount, ROTATION_K))`. It renders with an
  "extends your plan" pill.
- **Disjoint windows**: the rated proposal pool is the top-9 smoothed
  candidates; window `w = generation mod 3` covers ranks `[3w, 3w+2]`
  (regime decided on the PRE-filter slice; small pools keep the clamped
  cyclic walk). Duplicate PACKS dedupe within a set.
- **Regenerate is a QUEUE**: the dialog holds an EPHEMERAL `offeredIds`
  set (every variant shown this dialog session) and passes it in the
  request; offered candidates rank behind fresh ones, and the greedy
  slots skip them while the fresh pool can fill. NOT persisted — no
  store, no backup, no room payload. Closing the dialog resets it.
- **Generation 0 is bit-for-bit stable**: e2e pins the default
  pre-selected 4-pack `[13443, 6389, 11982, 6167]` (dinner, fresh
  profile, replace on empty). Any catalog or scoring change breaks those
  pins loudly — that is the contract working.

## Ratings, smoothing, favourites

Ratings are BAYESIAN-SMOOTHED caller-side (prior weight 10, mean over
the ELIGIBLE slice). The rating SOURCE is layered: the catalog mean is
the cold-start floor, and the household's own stars (`ratings`) override
it for rated recipes (prior weight 1) — see favourites + ratings below.

- The favourites store seeds from the user's own Mealime snapshot on
  FIRST RUN and is never re-seeded or cleared (`seedFrom` only ADDS).
  Internally `{favorited, updatedAt}` records MATERIALIZES the public
  `Set` synchronously on every write (never via a watcher); the
  persisted format stays the id array and tombstones are in-memory only.
- `useRatingStore` (`src/stores/rating.ts`) seeds EMPTY:
  `variant_meta.rating` is catalog truth and must NEVER be written into
  a rating. Ratings are 0..5 in 0.5 steps; re-rating from this device
  replaces the value and KEEPS `count`; a peer's newer record rolls the
  count forward.
- Auto-Plan weights (injected by `useAutoPlan`, the pure lib stays
  pure): household stars override the catalog's Bayesian mean for rated
  recipes and `favoriteIds` pay `FAVORITE_BONUS` (0.05) off a
  candidate's score — a weight only, never a command over waste.

## Dialog mechanics

- DEFAULT mode is ADD: the current plan's meals pre-commit as `baseIds`
  (their waste is shared), new meals append; replace keeps the
  confirm-before-destroy flow. Undo restores the exact prior plan
  (entries + cleared map) in BOTH modes.
- The dialog persists `autoPlanRuleset`, `autoPlanMode` and the rotating
  `autoPlanGeneration` counter in the ui store (STORE_SLICES
  registered). The counter advances at TWO points (ADR-0033): on every
  successful apply, and synchronously at the START of a press iff a
  preview is already set — a **Regenerate** press always rolls.
  `nextAutoPlanGeneration()` PEEKS and must never advance;
  `confirmAutoPlan` only bumps, so a pack previewed at generation N
  lands as shown.
- The confirm step PREVIEWS the pack (image + title per meal,
  `data-test="auto-plan-preview"`, resolved through
  `imageSrc`/`onImgError` like every other tile) before anything is
  applied.
- The proposal selection is EPHEMERAL view state — never persisted,
  never room-synced, no STORE_SLICES change.
- Known metric boundary: the ledger sees purchasable CONTAINERS only
  (ADR-0017); ~5% of dinner recipes have zero container rows and read
  as free. Count-noun extension is tracked in issue #79.
