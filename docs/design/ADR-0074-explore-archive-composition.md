# ADR-0074: Explore is the archive — count line, sort menu, and the card overlay grammar

Status: accepted (2026-10-09)

## Context

The Stitch "Recipes & Catalog" render (desktop + mobile) frames the
Recipes tab as an editorial archive: an eyebrow ("Pantry Index • Vol.
IV" — fiction), an availability-count line ("2,759 recipes available
offline" — real number, but the owner REJECTED the line and the word
"offline" on this surface), a sort DROPDOWN (Top Rated /
Popularity / Quickest / Calories), diet chips with per-diet glyphs, a
meal-type pill row, and a card whose photo carries overlay badges
(rating disc, protein-hue type chip) above a mono time/kcal row.

Current reality: QuickFilters (ADR-0027/0028) owns `sortBy`, diet chips
(`diet-chip-*`), `favOnly`, `protein` chips, `maxTime` — all persisted
in the `ui` slice; the grid is 1/2/3/4-col; cards show name + facts but
no overlay treatment; the sort control is a select-style control; the
offline count exists in the mono count line only after filtering.

## Decision

**The Recipes tab reads as the household's archive**, restyled within
QuickFilters — no filter-surface reorganisation (the ONE-object rule,
ADR-0027, holds):

- **No availability line**: the render's "2,759 recipes available
  offline" line is REJECTED (owner ruling) — the word "offline" means
  nothing to a reader inside the app, and the count already appears in
  the mono "Showing N of M" line under the filters when a filter is
  active. The header block carries the tab title only.
- **Sort dropdown**: `sortBy` renders as a proper menu (button + popover
  list with a check on the active option) instead of the native select
  look — the OPTIONS and the persistence are QuickFilters' unchanged
  members (`normalizeQuickFilters` still validates inbound values).
- **Card overlay grammar**: photo carries AT MOST — an espresso-disc
  favourite heart (existing `favourite` hue on disc, ADR-0073's disc
  grammar) and, when rated, a rating disc (star + mono value on the
  espresso disc). The protein-hue type chip stays OFF the photo and ON
  the facts row with the hue glyph (identity chips sit with the label —
  ADR-0036's "label stays" rule; an icon-only overlay chip fails it).
- **Facts row**: time + kcal in JetBrains Mono with their existing
  glyphs; kcal stays per-serving truth, never scaled. Sodium stays OFF
  cards (ADR-0024/§7 rule, e2e-enforced).
- **Meal-type pills**: the render's All Meals/Dinner/Lunch/… row maps to
  the ADR-0043 `recipe_types.json` occasion table — a NEW QuickFilters
  member (`mealType`) if the owner confirms it as a household
  preference; if adopted it follows the member rules (normalized
  inbound, persisted, non-synced... it syncs as part of QuickFilters'
  existing sync path if `ui` does). Sits as its own labelled row under
  the diet chips.
- **Rejected fictions**: "Pantry Index • Vol. IV", "Seasonal Archive"
  as copy, and the availability line (owner ruling above) — the archive
  tone comes from the typography and the mono count grammar, not
  invented volume numbers.

## Consequences

- QuickFilters gains at most ONE member (`mealType`), with
  `normalizeQuickFilters` extended and the persisted-slice contract
  respected; e2e pins for the diet/protein chips stay; new specs pin
  the sort menu (open/choose/check) and the count line.
- Card overlay badges are aria-labelled controls (favourite) or
  decorative-with-label (rating disc includes the value as text).
- The grid's column stages (1/2/3/4, no five-column) are untouched.
- No e2e assertion may reference an "offline" copy string — none exists.

## Alternatives considered

- **Rating + type chip both on the photo**: rejected — icon-only food
  chips on imagery violate the label-stays rule and crowd the photo.
- **Sort as chips instead of menu**: rejected — four mutually exclusive
  options read as a menu; chips imply multi-select (the diet row's
  grammar).
- **Curated "Featured" section**: rejected — no curation data exists;
  the grid IS the archive.

## Addendum (2026-10-09): implementation notes

Dated change note; Status stays Accepted.

- **The sort menu already existed.** ADR-0045 had already replaced the
  native `<select>` with the shared `FilterDropdown` — a button trigger
  with a popover listbox, a check on the active option and the
  Check-or-spacer alignment that stops labels shifting. ADR-0074's
  "proper menu" need was therefore met by grooming, not by building:
  `sortBy`, its options and `normalizeQuickFilters`' validation are
  untouched.
- **`mealType` already existed.** The occasion row maps to ADR-0043's
  `recipe_types.json` table, and `mealType` has been a sanitized,
  persisted `QuickFilters` member since ADR-0043 (commit `0c82196`), so
  this ADR's "a NEW member if the owner confirms" resolved to "already
  shipped" — no second member, no migration.
- **The rating disc is additive.** The photo carries at most the
  espresso favourite heart and, when rated, an espresso rating disc
  (star + mono value). The household's star WIDGET stays in the card
  body: it is a control on the ADR-0031 half-star grid, e2e-pinned, and
  a badge is not a control. The disc prints the household's rating when
  one exists and the catalog Bayesian mean otherwise — the same
  precedence `RatingStars` uses, so the two can never disagree.
- **ADR-0075 rule 5 (real data only).** No availability line ships; the
  offline count lives in the mono "Showing N of M" count line only when
  a filter is active. "Pantry Index • Vol. IV", "Seasonal Archive" and
  "Cookbook Storage Mode Active" are recorded as rejected fictions.
