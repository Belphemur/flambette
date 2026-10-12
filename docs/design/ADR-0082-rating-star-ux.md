# ADR-0082: The rating control — a labeled, touch-sized star card on detail and history

Status: accepted (2026-10-12)

## Context

Owner report (2026-10-12): the rating stars are not big enough on mobile and
it is not clear enough that they can be used to rate a recipe.

Measured present state (branch `feat/rating-star-ux`, off origin/main
`7841bb0`): the ONE rating component `src/components/RatingStars.vue`
(ADR-0031/0040) is mounted at

- **12px** on the recipe-detail metadata strip — an owner sizing note from
  the redesign mock ("size 12 so the strip never reads star-dominant"),
  which achieved its goal so well the control disappeared on mobile;
- **15px** on RecipeCard (`compact`, inside the tappable article);
- **14px** on HistoryView rows.

At 12px the half-star tap targets are ~6px wide — far below any touch
guideline — and the control carries no "this rates the recipe" affordance:
it renders as a read-mostly number beside a tiny star row. The e2e interacts
by accessible role (`getByRole('button', { name: 'Rate 4 of 5 stars' })`),
so sizing/presentation changes do not disturb the pins; the aria-label
string table (`starLabel`, ADR-0040's one-source contract) must not change.

Design exploration: Stitch project 2725470430841257407 (Warm Culinary Paper
design system `assets/146f70cf87be42a4aa2353420a3b07cd`), four screens —
recipe detail mobile `297334d3…` / desktop `f3255ec7…`, history desktop
`c538dccc…` / mobile `b7e6c14e…`. All four verified against their exported
HTML (only Plus Jakarta Sans + JetBrains Mono; zero native `title=`;
generator strays `#FFF8F0`, `#E5D8CB`, `#63574E`, `#FBEAE5`, `#8E2C17`,
`#F08A6A`, `#FFF0E6`, `#171310`, `#292524`, `#8C7A6B` are pre-redesign hexes
or near-misses the repo wins over — no new token ships).

## Decision

Owner rulings (2026-10-12, clarified as one form, recommended-first):

1. **Recipe detail: dedicated "Rate this recipe" card.** The rating leaves
   the metadata strip (that strip cell retires on detail) into its own
   cream-paper card — Level-1 presentation: `bg-surface` card,
   `1px border-border`, `12px` radius — containing the label
   "Rate this recipe" (`label-md`), the LARGE star control, the value in
   `font-mono-data` beside the stars, and the helper line
   "Tap a star — halves supported".
2. **Surfaces: recipe detail + History rows get the large interactive
   control** (cook-then-rate is the natural flow). RecipeCard keeps its
   compact display: the stars there sit inside a tappable article
   (navigational card), and a second large tap layer inside it is a
   mis-tap trap plus unwanted card growth.
3. **Unrated precedence unchanged** (ADR-0031/0074): the catalog Bayesian
   mean fills the stars as the dimmed fallback and the value prints it.
   The e2e-pinned semantics (`data-rating="0"` on a fresh profile) survive.
4. **A rating becomes removable**: a small "Clear" text control beside the
   value whenever the household has rated (`count > 0`).

### Presentation contract (from the renders, fictions rejected)

- **Star scale**: detail card **32px mobile / 24px desktop**; history rows
  **22px mobile / 24px desktop**; RecipeCard stays 15. The size becomes
  viewport-responsive INSIDE the one component (an optional `lgSize` prop
  resolved with `useMediaQuery('(min-width: 1024px)')` — the repo's
  established responsive signal, same composable as the reduced-motion
  build; never import `useReducedMotion`, it does not exist in the pinned
  `@vueuse/core`). Glyph and tap-target box both follow the size.
- **Colour**: the rated portion keeps the `text-warning` fill (saffron —
  the design system reserves it for "timing indicators, heat ratings";
  current `#9a3412` light / `warning-soft` dark, both already in
  `style.css` and the parity test's token set). The unrated outline moves
  from `text-text` to espresso-muted (`text-espresso-muted`/`text-muted`
  family) so a big glyph does not read as a heavy ink block. NO new hex.
- **Half-star grid untouched**: left half of slot `i` sets `i + 0.5`,
  right half `i + 1`; the clipped-overlay fill keeps rendering halves
  without half-star glyphs.
- **Touch targets**: the slot wrapper grows with the glyph (the star row is
  ~32px tall on mobile detail; the card padding carries the row past
  comfortable-thumb territory). No invisible-padding hacks.
- **Honest copy**: the "Synced to household" line from the render shows
  ONLY when the device is in a room (`room.inRoom`) — ratings are
  room-synced (ADR-0031), and a standalone install must not be told it
  syncs. "Tap a star — halves supported" always shows on the detail card.
- **Rejected fictions** (never shipped): the render's "SKU & test badge"
  header chip (no SKUs exist in the catalog); Material Symbols star glyphs
  (the repo ships bundled lucide `Star` only — ADR-0029); mock servings
  ("4+") and mock room names (design-mock data never enters real
  surfaces); the `#FFF8F0` surface (pre-redesign hex — `bg-surface` wins).
- **Deliberate divergence from the render**: History rows do NOT get the
  per-row "Tap to rate" helper copy — a dense feed repeating an
  instruction N times is noise; the enlarged interactive stars, the mono
  value beside them and the existing "Rated X of 5" toast carry the
  affordance there.

### Clear semantics (SOLID: one writer, propagation must be complete)

`setRating(id, 0)` already deletes the local record — but the room
transport publishes `ratings` only when non-empty and `mergeLww` never
removes keys, so a clear would never reach peers. The clear therefore
writes a **tombstone**, the same pattern favourites already use
(ADR-0031), adapted to the per-KEY LWW:

- `clearRating(variantId)` in the ratings store: stamps
  `now = Date.now()`, deletes the local record, records
  `tombstones[variantId] = now`.
- The room snapshot gains an ADDITIVE optional field
  `ratingTombstones?: Record<string, number>` (older peers ignore unknown
  optionals — the documented payload-evolution rule). On receive, a peer
  deletes any rating record whose `updatedAt <= tombstone` — deletion wins
  ties, mirroring "a stale push cannot resurrect" (ADR-0031). The sender
  keeps publishing its tombstones on every snapshot until peers have
  adopted, so a peer that joins late still loses the cleared record.
- Tombstones PERSIST inside the ratings slice (`ratings.json` gains a
  `tombstones` key; `sanitizeRatings` accepts and clamps it; the backup
  validator round-trips it). They are pruned never — they are tiny, and
  pruning requires knowing every peer has adopted, which is unknowable.
- Clear is immediate with a plain "Rating cleared" feedback toast — no
  confirm step: clearing is fully reversible by re-rating with one tap,
  so this is not a destructive action under the border-danger + confirm
  toast rule.
- The "Clear" control renders only when `count > 0`.

### DRY: one component, no forks

`RatingStars.vue` remains the ONLY rating control in the repo. The change
reshapes it (size responsiveness + presentation-neutral additions) and the
detail's labeled card is a thin wrapper mount — the half-star logic, the
`starLabel` string table, the store precedence and the toast feedback stay
exactly where they are. A second star widget anywhere is a review-reject.
Per DRY > SOLID > KISS: the rating behavior has exactly one source; the
card chrome is presentation layered on it, not a parallel implementation.
The store action (`clearRating`), the tombstone merge, and the viewport
size resolution each live in exactly one place.

## Consequences

- The detail strip loses its Rating cell (ADR-0074's composition is
  superseded in part — recorded there); the strip keeps time/kcal/servings.
- The e2e gains: the detail card heading + a ≥24px glyph bounding box on
  Pixel 7; the clear path (single-device) and the tombstone propagation
  (two-context room) cases; RecipeCard bounding boxes re-pinned only if
  the compact mount drifts. `household-ratings.spec.ts` role-based clicks
  are untouched.
- `stars`/rating value + fallback keep printing the same number the stars
  show (ADR-0031 precedence preserved; ADR-0074's one-precedence rule).
- Deferred e2e re-pins are listed in the commit message and land before
  the single full-suite run at the end (standing gate discipline).
- Unit specs: `rating.test.ts` gains tombstone merge/clamp cases and
  `clearRating` coverage (the `tsconfig.app.json` test-exclusion pitfall
  does not apply — signatures are additive, no call-site arity change).

## Alternatives considered

- **Enlarge the stars in place in the strip** — rejected (owner ruling):
  less layout churn but the strip stays cramped on mobile and the
  discoverability problem (no "rate me" cue) survives.
- **A second `RatingCard` component wrapping a slimmed inner widget** —
  rejected by DRY: two components would duplicate the half-star target
  layout and the label contract. One component + one wrapper mount.
- **Treat `rating: 0` records as stored tombstones through the whole
  pipeline** — rejected: every reader (`displayRating`, Auto-Plan scoring,
  backup rows) would need a "0 means unrated" special case; the additive
  tombstone field keeps `ratings` semantics exactly as documented.
- **No tombstones (clear stays single-device)** — rejected: the owner
  asked for a real removal; a clear that silently resurrects on the next
  peer snapshot is a false-delivery bug, not a v2 feature.
