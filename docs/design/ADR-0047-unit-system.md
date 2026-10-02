# ADR-0047: Unit system (dual/metric/imperial) with display-time conversion

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
The user wants a unit-system setting that converts everything —
temperatures, ingredient quantities — automatically, with a settings-tab
control AND a one-tap toggle on any recipe view.

The catalog's own authoring is DUAL (`220°C (425°F)`, `450°F (232°C)`,
inconsistently), and half its quantities are already metric. So the setting
is THREE modes, not two: `dual` — the catalog exactly as authored — plus a
`metric` and an `imperial` reading. `dual` is the default because it is the
only mode that is a TRUE identity: an install that never touches the
control renders byte-for-byte what it rendered before this ADR, which is
what keeps every pre-existing e2e display pin valid.

Measured conversion surface over the frozen catalog:

| Kind | Occurrences | Metric → Imperial |
| --- | --- | --- |
| Temperature (step text) | 1,711 | °C ↔ °F, dual notation collapsed to one |
| Mass | 1,761 `kg`, 584 `g` (+ `(142 g)` annotations) | kg → lb, g → oz |
| Volume | 955 `ml` (+ `(398 ml)` annotations) | ml → fl oz |
| US volume | 2,074 `cup(s)`, 129 `tbsp` | `cup` is a purchased CONTAINER: count kept, volume annotated (`1 cup` → `1 cup (240 ml)` metric / `1 cup (8 fl oz)` imperial); `tbsp` unchanged |
| Length | 309 `(2 ½ cm)` annotations, ~42 step-text mentions | cm ↔ inch |
| Nutrition | kcal / mg everywhere | unchanged (system-agnostic labels) |
| Imperial stragglers | 11 `(3 oz)`, 7 `1 inch`-style | oz stays oz in imperial; inch stays inch |

## Decision

1. **All conversion is DISPLAY-TIME.** The catalog, the pack index and every
   persisted store stay canonical metric. Nothing is rewritten at rest, the
   same way container units are formatted but never re-authored (ADR-0017).
   A pure lib — `src/lib/units.ts` (`UnitSystem = 'dual' | 'metric' |
   'imperial'`, temperature text transform, quantity/line localization) —
   is the only conversion code; no Vue/Pinia imports, unit-tested like the
   rest of `src/lib`. `dual` is the identity in both transforms; the two
   single-system modes apply the conversions below.

2. **`ui.unitSystem` is a device-local preference** (default `'dual'`),
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
   - `dual`: the authored string, untouched — dual notation INCLUDED.
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

5. **Cups are containers, not an imperial-native unit.** A `cup` is a
   purchased object whose volume is invisible, so a reader who picked ONE
   system is shown that volume in parentheses — `1 cup (240 ml)` (US legal
   cup, exact) in metric, `1 cup (8 fl oz)` in imperial. It is the SAME
   annotation grammar the catalog already uses for its own container weights
   (`½ (142 g) pkg` → `½ (5 oz) pkg`), deliberately not a special-cased
   rewrite: the container COUNT is never converted in any mode, only the
   unit/annotation. `dual` leaves `1 cup` as authored. A quantity that
   already carries an authored annotation is not annotated twice.

6. **Affordances**: Settings tab gains a unit-system control card (same card
   grammar as Default servings, ADR-0037), and RecipeDetail gains a compact
   `Dual | Metric | Imperial` segmented control in the actions panel —
   writing the SAME store value, so the two surfaces are one setting, not
   two.

## Implementation notes (as built)

Recorded here because each one is a place where the implemented behaviour is
narrower or wider than a first reading of the sections above suggests.

- **`dual` is the IDENTITY, everywhere.** The default renders the authored
  catalog exactly: `220°C (425°F)` stays `220°C (425°F)`, `1 cup` stays
  `1 cup`, `450 g` stays `450 g`. Nothing about the display changes until a
  reader explicitly picks a single system, which is what makes the default
  safe for every pre-existing display pin.
- **Metric is the IDENTITY for every QUANTITY it already owns, but not for
  step PROSE.** A metric amount (`450 g`, `1 ½ (142 g) pkg`) is returned
  unchanged, so no existing quantity pin can churn. Step text is the
  exception in the two single-system modes: the catalog's dual notation
  reads badly once you have asked for ONE system, so the temperature pass
  collapses the pair to one token. A step that mentions no temperature and
  no length is returned as the authored string, byte for byte, in every mode.
- **A restatement keeps the notation the author already wrote in the target
  system** (`220°C (425°F)` → `220°C` metric / `425°F` imperial), rather
  than converting the first token and rounding it again. Two authored
  notations count as the same temperature when they agree within **7 °C**
  (measured, not guessed: the worst pair in the corpus, `225°C (425°F)`, is
  6.7 °C apart, and the common `200°C (400°F)` sloppiness is 4.4 °C). Every
  genuine dual-notation pair in 2,759 recipes is inside that tolerance, and
  a parenthetical genuinely stating a different temperature is converted
  independently rather than dropped.
- **A temperature RANGE converts BOTH bounds.** The catalog writes its degree
  sign once (`180-200°C`), so the lone-token pass would convert only the
  upper bound; a range pass runs first. The degree sign is what keeps it
  safe, so `20-25 minutes` stays prose.
- **There is deliberately no bare `in` length unit.** The corpus spells
  lengths in full (`inch`/`inches`) — 0 occurrences of `<number> in` across
  2,759 docs — while `<number> in` is ordinary English (`cut 2 in half`), so
  the abbreviation could only ever corrupt prose. Hyphenated lengths (`3-inch`,
  `1 ¼-cm` — 408 corpus occurrences) DO convert.
- **Only temperatures and lengths convert inside step prose.** A mass or
  volume written into a step detail line (`1.02 kg new potatoes`) stays as
  authored; the ingredient list, the grocery lines and the measured chips
  are the converted surfaces. Rewriting prose numbers is the re-authoring
  this ADR exists to avoid.
- **Lengths use `formatAmount`'s one-decimal grammar**, so `2 ½ cm` reads
  as `1 inch` — coarse on purpose for cutting lengths, and the same
  grammar every other amount in the app uses.
- **An authored amount head is never reflowed.** `parseQuantity` sums a
  fraction into a float, so `localizeQuantity` matches the leading amount as
  a SPAN and re-parses that span: `½ (142 g) pkg` reads `½ (5 oz) pkg`, never
  `0.5 (5 oz) pkg`, and the ASCII form `1/2 (227 g) blocks` keeps its count
  and converts its annotation.
- **In the backup slice `unitSystem` is deliberately NOT defaulted** (unlike
  `defaultServings`, which restores the authored 6): absent means "don't
  touch", so restoring an older archive can never silently flip a device
  between systems. Both surfaces write the value through the store's
  validating setter, and a hand-edited blob is repaired in `afterHydrate`.
- **The recipe-detail toggle is a three-option segmented control** labelled
  `Dual`, `Metric` and `Imperial` — the SAME words as the Settings card,
  which additionally spells out what each mode reads as. Both surfaces read
  the one `UNIT_SYSTEM_LABEL` registry in `lib/units`, so the labels cannot
  drift (an earlier draft labelled the toggle `°C/°F`, `°C / g`, `°F / oz`,
  which are not three options a reader can choose between — `°C/°F` is what
  Dual reads, and no mode puts `g` and `°C` in one button). One store
  member, one validating setter.

## Consequences

- Dual is the default and is bit-for-bit today's output: existing e2e
  display pins (grocery lines, `½ (142 g) pkg`, step text) stay green
  without touching a single spec.
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
- **Convert a cup into millilitres outright** (`1 cup` → `240 ml`): it would
  break the count-as-purchased-object rule the whole container grammar rests
  on, and it churned every existing pin — rejected. Annotating the cup in
  place (Decision 5) keeps both.
- **Two modes only, with metric as the default**: metric is not a true
  identity (the temperature pass still rewrote prose), so the "default
  changes nothing" guarantee could not be made honestly — superseded by the
  three-mode shape, where `dual` can.
- **Store both notations and let CSS pick**: temperatures are prose, not
  data; a text transform is the only honest surface — rejected.