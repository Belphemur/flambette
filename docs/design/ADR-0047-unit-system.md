# ADR-0047: Unit system (metric/imperial) with display-time conversion

## Status

Proposed (implemented by supervised pi phase; owner review pending).

## Date

2026-10-02

## Context

The frozen catalog is authored metric — every one of the 2,759 docs carries
`units: "Metric"` — but a household that buys in imperial units (oz, lb, fl
oz) reads every quantity in a system it doesn't shop in. Instruction text is
worse: it is DUAL-NOTATION but inconsistently (1,711 temperature mentions,
some `220°C (425°F)`, some `450°F (230°C)`), so neither system reads clean.
The user wants a metric/imperial setting that converts everything —
temperatures, ingredient quantities — automatically, with a settings-tab
control AND a one-tap toggle on any recipe view.

Measured conversion surface over the frozen catalog:

| Kind | Occurrences | Metric → Imperial |
| --- | --- | --- |
| Temperature (step text) | 1,711 | °C ↔ °F, dual notation collapsed to one |
| Mass | 1,761 `kg`, 584 `g` (+ `(142 g)` annotations) | kg → lb, g → oz |
| Volume | 955 `ml` (+ `(398 ml)` annotations) | ml → fl oz |
| US volume | 2,074 `cup(s)`, 129 `tbsp` | unchanged (already imperial-native) |
| Length | 309 `(2 ½ cm)` annotations, ~42 step-text mentions | cm ↔ inch |
| Nutrition | kcal / mg everywhere | unchanged (system-agnostic labels) |
| Imperial stragglers | 11 `(3 oz)`, 7 `1 inch`-style | oz stays oz in imperial; inch stays inch |

## Decision

1. **All conversion is DISPLAY-TIME.** The catalog, the pack index and every
   persisted store stay canonical metric. Nothing is rewritten at rest, the
   same way container units are formatted but never re-authored (ADR-0017).
   A pure lib — `src/lib/units.ts` (`UnitSystem = 'metric' | 'imperial'`,
   temperature text transform, quantity/line localization) — is the only
   conversion code; no Vue/Pinia imports, unit-tested like the rest of
   `src/lib`.

2. **`ui.unitSystem` is a device-local preference** (default `'metric'`),
   persisted on the `mealime-planner:v1:ui` slice and carried in the
   settings.json backup slice (ADR-0013 registry rule). Deliberately NOT
   household state (same reasoning as ADR-0037's `defaultServings`): the
   shared truth — plan entries, checked keys, cleared keys — is
   unit-independent, and one member cooking from a metric-printed phone must
   not force the other's display. An install that never touches the control
   behaves bit-for-bit as today, which is what keeps every existing e2e pin
   valid.

3. **Grocery checkbox keys stay canonical.** The persisted `checked` map keys
   are `<nameKey>||<display>`; if aggregation localized the display, one
   toggle of the setting would orphan every checked item and silently
   desync households running different systems. `GroceryLine.display` remains
   the canonical key basis; the localized text is a separate render-time
   value produced in `useGroceryList` (one localized pass, both GroceryTab
   and ShopView consume it). Measured-amount chips (ADR-0022) localize the
   same way, through the same lib.

4. **Step text converts temperatures (and lengths) at render.** RecipeDetail
   and CookingView already share `scaleSteps`; both apply the localization
   pass after scaling so the two surfaces never drift. The transform:
   - metric mode: every °F token converts to °C; a parenthetical that
     merely restates the same temperature in the other system is dropped
     (`Preheat oven to 220°C (425°F).` → `Preheat oven to 220°C.`, and
     `450°F (230°C)` → `230°C`).
   - imperial mode: the mirror (`425°F`, `230°C` → `75°F` etc.).
   - Tokens of the target system pass through; a parenthetical that adds
     information (e.g. a DIFFERENT temperature) converts independently
     rather than being dropped.
   - Round: °C→°F nearest integer (with 0.1-tolerance dedupe against the
     authored roundings, `205°C` ↔ `400°F`); lengths nearest tenth like
     `formatAmount`.
   - The verbatim-authenticity rule is untouched: storage keeps the authored
     text; only what reaches the screen converts.

5. **Affordances**: Settings tab gains a unit-system control card (same card
   grammar as Default servings, ADR-0037), and RecipeDetail gains a compact
   metric/imperial toggle in the actions panel — writing the SAME store
   value, so the two surfaces are one setting, not two.

## Implementation notes (as built)

Recorded here because each one is a place where the implemented behaviour is
narrower or wider than a first reading of the sections above suggests.

- **Metric is the IDENTITY for every QUANTITY, but not for step PROSE.** A
  metric amount (`450 g`, `1.5 (142 g) pkg`, `½ (142 g) pkg`) is returned
  unchanged, so no existing quantity pin can churn. Step text is the
  exception: the catalog's dual notation reads badly in metric too
  (`220°C (425°F)`), so the temperature pass runs in BOTH systems and
  collapses the pair to one token. A step that mentions no temperature and
  no length is still returned as the authored string, byte for byte.
- **A restatement keeps the notation the author already wrote in the target
  system** (`220°C (425°F)` → `220°C` metric / `425°F` imperial), rather
  than converting the first token and rounding it again. Two authored
  notations count as the same temperature when they agree within **7 °C**
  (measured, not guessed: the worst pair in the corpus, `225°C (425°F)`, is
  6.7 °C apart, and the common `200°C (400°F)` sloppiness is 4.4 °C). Every
  genuine dual-notation pair in 2,759 recipes is inside that tolerance, and
  a parenthetical genuinely stating a different temperature is converted
  independently rather than dropped.
- **Only temperatures and lengths convert inside step prose.** A mass or
  volume written into a step detail line (`1.02 kg new potatoes`) stays as
  authored; the ingredient list, the grocery lines and the measured chips
  are the converted surfaces. Rewriting prose numbers is the re-authoring
  this ADR exists to avoid.
- **Lengths use `formatAmount`'s one-decimal grammar**, so `2 ½ cm` reads
  as `1 inch` — coarse on purpose for cutting lengths, and the same
  grammar every other amount in the app uses.
- **In the backup slice `unitSystem` is deliberately NOT defaulted** (unlike
  `defaultServings`, which restores the authored 6): absent means "don't
  touch", so restoring an older archive can never silently flip a device
  between systems. Both surfaces write the value through the store's
  validating setter, and a hand-edited blob is repaired in `afterHydrate`.
- **The recipe-detail toggle is a two-option segmented control** labelled
  `°C / g` and `°F / oz`; the Settings card labels the same values
  `Metric` and `Imperial`. One store member, one validating setter.

## Consequences

- Metric mode is the default and is bit-for-bit today's output: existing
  e2e display pins (grocery lines, `½ (142 g) pkg`, step text) stay green.
- Toggling the system re-renders instantly everywhere (computed off the ui
  store); no persistence of converted text anywhere.
- The `checked` map survives a toggle with zero churn — keys never change.
- Cross-device rooms stay coherent regardless of each device's setting.
- The temp/quantity transform must be tolerant of the catalog's mixed
  authoring; goldens in `units.test.ts` pin the real catalog examples above.
- Imperial rounding is approximate by nature (5 oz ≈ 142 g); the grocery
  line keeps the canonical key so a hand-checked item never unchecks.
- A step's own masses read metric in imperial mode until the ingredient
  list is consulted (see Implementation notes) — the honest limit of a text
  transform over authored prose.

## Alternatives considered

- **Convert at ingestion** (rewrite quantities when the doc loads): would
  re-author cached docs, break the verbatim rule, and make the aggregation
  keys system-dependent — rejected.
- **Household-synced unitSystem**: rejected — a display preference, not
  household data; the plan entries already carry the shared numbers.
- **Convert cups → ml in metric mode**: the catalog's metric mode IS
  today's display; converting cups would churn every existing pin for no
  user need — rejected.
- **Store both notations and let CSS pick**: temperatures are prose, not
  data; a text transform is the only honest surface — rejected.