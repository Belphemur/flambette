# ADR-0089: Pantry becomes the Kitchen filter dropdown on the Recipes tab

Status: accepted (2026-10-14) — implemented in PR #90; supersedes ADR-0087 in part (Decision 1 surface placement)

## Context

Issue #80 shipped as ADR-0087: an "In my kitchen" ingredient chip row as a
dedicated sibling row of the quick-filter rows (`PantryFilterRow.vue`
between the FilterDropdown row and the quick filters in `RecipesTab.vue`),
with its own add-ingredient search input (`PantryIngredientAdd.vue`).
Post-merge review (owner, 2026-10-14): the Recipes tab now carries TWO
search-like bars — the header recipe search and the pantry add input — and
the owner judged the result cluttered: "we need some kind of separation or
more clarity… might need to rethink the UX after all".

Two de-clutter directions were generated as REFINE variants of the adopted
Variant A screens in Stitch project 2725470430841257407 ("Flambette Recipe
App", Warm Culinary Paper):

- **Direction D — Kitchen filter dropdown**: the pantry joins the existing
  filter anatomy as one dropdown chip; the standalone row disappears.
- **Direction E — unified search bar with in-field tokens**: pantry chips
  become tokens inside the header search field (an evolution of the old
  "Variant C: all together search" screen).

Screens generated (both devices, per the owner's scoping choice):
D desktop "Flambette — Recipes (Kitchen Filter Dropdown Open)"
(screen `1e74d87d86134d5a8ec5a1724e4b4a54`), D mobile "Flambette — Recipes
(Mobile Kitchen Dropdown Filter Open)" (screen
`b354d35ecf7b4ee7b8d5bde9d47f1d34`), E desktop "Flambette — Recipes
(Unified Search Bar with In-Field Tokens & Dropdown)" (screen
`38f846b1720e43399430ad7ee323feba`), E mobile "Flambette — Recipes (Mobile
Unified Search with In-Field Tokens & Dropdown)" (screen
`dd01a8f5f76a4be5bdd7fd9a7fc7a8a9`). The owner picked **Direction D**,
praising the dropdown, the kitchen glyph in front of the chip, and the red
(primary) count colouring: "This is the best UX with the dropdown, clear
icon in front of the fridge, the red coloring."

The implementation worker reads the adopted screens directly from the
Stitch MCP server (project `2725470430841257407`) — the record cites IDs
and titles so the render is re-findable without this session.

## Decision

**The pantry stops being a row and becomes the "Kitchen" filter dropdown.**
Direction D's two screens are the design authority; ADR-0087 remains
behavioural authority for everything this record does not move.

1. **Surface placement (supersedes ADR-0087 Decision 1).** The dedicated
   "In my kitchen" row and its always-visible add-ingredient pill are
   REMOVED from the tab flow. The pantry renders as a `Kitchen` chip in the
   existing filter chip row (the `FilterDropdown` row — cook time, sort,
   meal, source — first position in the row, per the render). Chip anatomy
   per the render: kitchen glyph (the repo's shipped `Refrigerator` lucide
   glyph, the nearest honest shape — lucide 1.55.0 ships no `Kitchen`;
   same substitution already ruled in the ADR-0087 addendum notes),
   label "Kitchen", an active count badge (primary fill, on-primary text,
   mono, 2-digit-safe), and the chevron. Inactive (empty pantry): plain
   outlined chip, no badge, chevron down.
2. **Open-state panel** (the render's focal point, anchored under the
   chip): header row = kitchen glyph + "In My Kitchen" + "N items" badge
   (secondary-container fill, primary text, mono) + "Clear all" text
   action, divided by `border-warm/70`; the existing pantry chips with
   accessible remove buttons; the add input ("Add an ingredient you
   have..."); the suggestion list; a footer line "Showing recipes that
   match what you already have" (mono, muted, decorative glyph).
3. **Suggestion rows carry state.** A suggestion already in the pantry
   renders with a check glyph and the meta "Active in kitchen" (render:
   green `check_circle`); others render the primary `add` affordance.
   Selecting a suggestion adds it to the pantry exactly as today —
   `PantryIngredientAdd`'s suggestion engine (`suggestIngredients`,
   `isSuggestionListVisible`) stays THE single source; the dropdown panel
   hosts it, it does not fork it.
4. **Everything below the chip is unchanged** (ADR-0087 continues to
   govern): the `src/lib/pantry.ts` match surface incl. Addendum §1
   name-surface matching, the ≥1-overlap filter, missing-ascending
   implicit ranking, card badges, persistence slice, STORE_SLICES, and
   the results-summary heading "Cook With Your Pantry" + real count +
   aria-live text (Addendum §2). The chip's count badge and the panel's
   "N items" badge are the SAME number from the SAME store — one count
   source, re-rendered twice, never computed twice.

### Rejected render fictions (not adopted)

- Suggestion qualifiers ("cherries (sweet / tart)", "chervil (fresh
  herb)") — suggestions render the plain catalog names the engine returns.
- Per-suggestion recipe counts ("14 recipes", "6 recipes") — the engine
  does not count recipes per ingredient; adding an index for it is a
  separate decision, not smuggled in here.
- The top status banner "Cook with what I have • 4 ingredients active"
  above the search bar — a duplicate count surface that also contradicts
  the panel ("2 items") in the render itself; the Addendum §2 results
  summary stays the one count context near the results.
- A "Fewest Missing" entry in the sort dropdown — ADR-0087's no-new-SortBy
  ruling stands; ranking stays implicit while the filter is active.
- kcal figures on recipe cards, meal-category chip rows as drawn —
  previously rejected fictions (ADR-0087), not re-adopted by this render.
- Material Symbols glyphs — the repo's icon role registry (lucide) wins;
  the render's glyph choices map through the registry.

### Alternatives considered

- **Direction E (tokens in one search bar)** — recorded alternative,
  screens listed above. Rejected for this round: in-field token chips
  complicate the search field's state machine (free text + structured
  tokens), and the pattern's discoverability is weaker; revisit if the
  dropdown still reads as clutter after shipping.
- **Keep the row, restyle only** — rejected: keeps the two-bars problem
  the owner flagged.

## Consequences

- `PantryFilterRow.vue`'s row anatomy is retired; its content re-hosts
  inside the dropdown panel. The add input's focus-return, IME guard,
  suggestion-race token, and clear hooks (post-review fixes in PR #90)
  move with it unchanged in behaviour.
- Mobile: the chip lives in the horizontally scrollable filter row; the
  panel is full-width (mobile screen). The row-overflow e2e pin
  (scrollWidth ≤ clientWidth) now pins the filter row with the chip.
- e2e hooks: `pantry-row` becomes the trigger chip + panel; `pantry-add`,
  `pantry-chip-<nameKey>`, `pantry-clear`, `pantry-badge`,
  `pantry-summary`, `pantry-heading` carry over; the collapsed-by-default
  pin becomes "chip renders inactive, panel closed".
- ADR-0087 stays accepted for all rulings except Decision 1's placement;
  its Status line carries the in-part supersession pointer.

## Numbering note

`--next` hands out 0088, but ADR-0088 is already reserved by the in-flight
`feat/relay-sqlite-persistence` branch (remote-branch scan). This record
takes **0089** to avoid the collision.
