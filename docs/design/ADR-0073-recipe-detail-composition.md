# ADR-0073: Recipe detail adopts the two-column composition; cooking keeps the command room

Status: accepted (2026-10-09)

## Context

The Stitch "Recipe Detail & Cooking Mode" render prescribes a
composition the slice-3 flagship pass only approximated (it re-painted
the existing single-column stack): a 2-column intro (5-col photo card /
7-col meta card), a key-metadata strip, a checklist-style ingredient
card, and a step LIST whose steps carry number badges and inline timer
components. Separate fiction inventory in the same render: macro split
bar (protein/carbs/fat/sodium), cookware module, pro tips, "Tested 6x",
SKU, voice-listening banner, "Beginner Friendly", step category labels.

The catalog's nutrition truth is `meta.calories` + `meta.sodium_mg`,
PER-SERVING (AGENTS.md Nutrition rule). Protein/carbs/fat DO NOT EXIST
in the catalog and are not derivable — the render's macro bar cannot be
built honestly. Cookware, tips, difficulty, test counts and SKUs are
invented.

## Decision

**Detail TEACHES (the render's editorial two-column), cooking COMMANDS
(one step, unchanged room).**

- **Intro, desktop**: photo card left (`lg:col-span-5`, 4:3, rounded,
  espresso scrim gradient bottom — the scrim may carry the
  household-recipe badge and the favourite heart disc); meta card right
  (`col-span-7`): H1, description, metadata strip, actions, nutrition
  line. Mobile stacks photo → title/facts → actions → ingredients →
  steps (unchanged order, restyled).
- **Metadata strip** (real data only): Total time (`cooking_minutes`),
  Calories per serving (`meta.calories` — never scaled), household
  rating (ADR-0031 stars; catalog Bayesian mean as fallback display),
  servings stepper (existing control restyled into the strip). Sodium
  keeps its ADR-0036 droplet chip on the same strip. The render's
  "★★★★★" glyphs become the existing star-icon control.
- **Ingredient checklist card** (desktop sticky left column, mobile
  inline): rows are name-left + right-aligned JetBrains Mono quantity
  (the ADR-0071 qty-badge grammar), each row checkable with the
  ADR-0072 success state. Check state is EPHEMERAL view state on this
  surface (like ADR-0070's search query) — not persisted, not synced;
  "Mark all ready" toggles all. Quantities re-render at the stepper's
  servings through the ONE scaling path (ADR-0022's scaler family).
- **Step-list preview on detail**: steps render as cards with number
  badges; a step whose ADR-0041 timer hint exists shows its inline timer
  affordance (the ADR-0020 per-view timer contract applies — the
  detail's preview timers are the same `ui.stepTimers` store, one timer
  per step view). Step text stays verbatim; measured-amount chips keep
  ADR-0022's rule.
- **Cooking mode keeps the 672px command room** (ADR-0010/0016): one
  step, thumb controls — the render's all-steps-visible page is the
  DETAIL page's job. The bottom sticky nav adopts the render's shape:
  Previous / step counter (mono "Step N of M") / Next, and Finish
  cooking filled `success` (ADR-0072). The ask-first-if-timer-running
  guard (ADR-0020) is untouched.
- **Rejected fictions**: macro split bar (no protein/carb/fat data — a
  kcal+mg "split" is semantically wrong too), cookware module, pro
  tips, "Beginner Friendly", "Tested N×", SKU strings, voice banner.
- **Room pill**: the joined-room indicator rides the app header's room
  chip (EXPERIENCE §5), not a per-page duplicate.

## Consequences

- Recipe detail e2e: layout assertions re-pinned for the two-column
  desktop grid; new specs for the checklist (toggle, mark-all, ephemeral
  = gone after reload) and the metadata strip's values.
- The servings stepper on detail now live-scales the checklist display —
  through the existing scaler, no new maths.
- The favourites heart keeps its `favourite` hue (ADR-0036 identity
  family), rendered on the espresso disc as today.
- Dark mode: scrim + checklist states ride the flip tokens; sweep pairs
  added (checklist checked, step badges).

## Alternatives considered

- **2-segment nutrition bar (kcal/sodium)**: rejected — neither is a
  part of a whole; a bar implies a split. Chips/strip render the facts.
- **All-steps-visible cooking mode**: rejected — the immersive one-step
  room is ADR-0010's pinned behaviour and the flagship's "commands"
  half; the render conflates detail and cooking.
- **Checkable ingredients synced across the room**: rejected —
  prep state is personal and short-lived; syncing it buys noise in the
  whole-state payload for no household value (the SHOP list is the
  synced checklist).
