# ADR-0072: Completion colour is the success family, never a food hue

Status: accepted (2026-10-09)

## Context

The Stitch renders fill the grocery checkbox with `#137A38` — byte for
byte the repo's `hue-vegetarian`. ADR-0036 made a hue the icon's
IDENTITY (ingredient type), never its state, and the food greens are
claimed: `hue-vegetarian` marks vegetarian recipes, `hue-vegan` vegan
ones. Reusing one as the "done" fill makes a checked-off Salmon-couscous
line read vegetarian.

DESIGN.md v2 already ships the `success` family (`success #116149`,
`success-soft #34D399`, `on-success #FFFFFF`) with dark pairs — it was
added in the token migration and currently has no consumer.

EXPERIENCE §6 (draft) said "checked = tomato fill (grocery) / herb
green (prep)" — written before the success family existed and before
this question was put to the owner.

## Decision

**A COMPLETION state renders with the `success` family — never a food
hue, never brand.**

- Grocery + Shop checkboxes: checked fill `success`, check glyph
  `on-success`; struck + muted text. Unchecked: `surface` fill +
  `border-strong` keyline.
- Complete-state pills: the `N/M` pill and any "all done" section pill
  render `success`-tinted (light `success` at low alpha + `success`
  text; dark via the flip pair).
- The cooking-mode **Finish cooking** action fills `success` — it is a
  completion commitment, not a start intent. Tomato stays the START
  intent (Start shopping / Start cooking / Auto-Plan); this gives the
  two intent colours a clean split: tomato = begin, success = complete.
  One filled intent per surface still holds (the colours differ).
- **Not completions, unchanged**: preference toggles (settings switches,
  share-history checkbox — they are configuration, not progress), the
  Plan tab's cleared-ingredient checkboxes (cleared = REMOVED, a
  different fact than bought — danger-family semantics would also be
  wrong; they keep `accent-brand` until a surface pass reaches them),
  favourites (stay `favourite`).
- The amendment to EXPERIENCE §6: checklists checked = `success` fill.
- Measured for WCAG before shipping: `success` vs `on-success` and the
  `success` fill against both paper surfaces in both themes — the hue
  must clear the non-text 3:1 gate the checkbox fill lives under.

## Consequences

- `src/lib/palette.ts` gains a `success` icon role only if an icon needs
  it (check glyphs are inline, not registry roles — the registry is for
  food/nutrition icon identity).
- The contrast sweep adds the success pairs to its table.
- Every surface the sweep covers gets the same checked-state language;
  the cross-surface grammar contract (ADR-0075) enumerates the call
  sites so no checkbox family drifts.

## Alternatives considered

- **Adopt Stitch's `#137A38` as-is**: rejected — hue-identity collision
  (ADR-0036); a vegan-green done-state on a meat recipe is a lie.
- **Espresso fill**: viable but quieter than the owner chose; a dedicated
  completion colour also gives Finish-cooking its semantic home.
- **Tomato fill** (the §6 draft): rejected — tomato is spent on start
  intents; a filled tomato checkbox on every checked row dilutes the
  one-filled-tomato rule.
