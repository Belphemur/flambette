# ADR-0039: Nutrition facts modal with a macro donut

**Status:** Proposed (2026-10-01)
**Extends:** [ADR-0004](ADR-0004-per-serving-nutrition.md) (nutrition is
per-serving; only totals scale), ADR-0036 (DESIGN.md token layer), ADR-0029
(Lucide icon stack), ADR-0013 (backup registry — nothing new persisted).

## Context

The recipe detail shows exactly three nutrition facts today
(`RecipeDetail.vue` `data-test="nutrition"`): `Math.round(meta.calories)`
kcal/serving, cooking minutes, and `meta.sodium_mg` when present — plus
three brand-ramp macro bars (Protein/Carbs/Fat) rendered from
`meta.macros` as fractions.

The recipe document, however, carries a COMPLETE nutrition block
(`public/data/recipes/<id>.json` → `nutrition`): 59 keys on every one of
the 2,730 recipes — energy, carbs, fiber, sugars, starch, the four real
sugars, fat, monounsaturated, polyunsaturated, omega_3/omega_6,
saturated, transfats, cholesterol, protein, all 18 amino acids, B1–B12 +
choline + folate + vitamins A/C/D/E/K, and 11 minerals including sodium.
All of it is **already shipped offline** but only `doc.nutrition` energy
and sodium are used (via `meta.calories`/`meta.sodium_mg` mirrors).

The owner asked for: (a) an openable modal with the full details, and
(b) a pie-chart macro visualisation like the reference (MyFitnessPal):
percent-of-calories macro donut with the calorie total in the hole,
legend chips beside it, e.g. `Fats 31% / Carbs 56% / Protein 13%`.

## Decision

### 1. Open the nutrition section — a modal, not a busy detail block

The existing nutrition section becomes a **summary + trigger**: the
today-visible facts stay exactly where they are (the section keeps
`data-test="nutrition"` and its e2e position contract), and the section
becomes a button affordance (or gains a clearly labelled "Full
nutrition facts" control) that opens a dedicated modal
(`data-test="nutrition-modal"`, `role="dialog" aria-modal="true"`,
Escape-closes like every other dialog in the app). Deferred detail stays
out of the initial view: the section's chrome does not grow.

`aria-modal="true"` is a PROMISE, so the modal keeps focus: it records
`document.activeElement` before moving focus into the panel, TRAPS Tab /
Shift+Tab inside the panel (the modal is teleported to `<body>`, so
without the trap Tab walks into the still-mounted detail behind the
backdrop), and restores focus to the recorded element on every close
path (close button, Escape, scrim, parent-driven close — unmount covers
all of them). Because `RecipeDetail` mounts it `v-if`-gated, one mount
is exactly one open, which is what makes the component-level
`onMounted`/`onUnmounted` pair sufficient. The `nutritionOpen` flag is
also cleared on every doc load, so navigating to another recipe starts
with the modal closed instead of remounting it for the next recipe.

### 2. The modal shows the per-serving nutrition, ALL of it by group

One serving — never scaled by servings (ADR-0004). The full
`doc.nutrition` is laid out in grouped sections: Fats (total, saturated,
monounsaturated, polyunsaturated, omega-3/omega-6, trans, cholesterol),
Carbohydrates (total carbs, starch, fiber, sugars), Protein (+ per-AA
disclosure), Vitamins and Minerals (vitamin A/C/D/E/K, B1/B2/B3/B5/B6/
B12, choline, folate, calcium, iron, magnesium, phosphorus, potassium,
sodium, zinc, selenium, copper, manganese). Water/ash/caffeine/alcohol
and micronutrients are in a collapsed-by-default remainder group.
Units: grams per serving for the masses, with an EXPLICIT unit for
every one of the 66 catalog keys (unit-tested for completeness, so a
missing entry can never silently print grams): `kcal` for `energy`;
`mg` for sodium, cholesterol, vitamin C/E, B1–B6, choline, caffeine and
the milligram minerals (calcium, copper, iron, magnesium, manganese,
phosphorus, potassium, zinc); `µg` for vitamin A/D/K, B12, folate and
selenium; `g` for everything else (macros, sugars, amino acids, water,
ash, alcohol, sugar alcohols).

### 3. The macro donut is CALORIES-DERIVED, not gram-derived, and can never lie

The reference pie shows macro **percent of calories**, using the
standard 4 kcal/g for carbs and protein and 9 for fat, with **fiber
charged at its NET 2 kcal/g** (USDA counts fiber at 4 for the food
energy total, but a good part of it is not metabolised; without the
discount a high-fiber recipe such as catalog 9148 derives 746 kcal
against its published 701 and would lose its donut):
`fatPct = 9·fat/energy`, `carbPct = (4·carbs − 2·fiber)/energy`
(fiber clamped to `[0, carbs]`), `proteinPct = 4·protein/energy` (each
clamped ≥ 0, and the triple SUM-normalised only when it lands in
1.0 ± 0.12 — catalog rounding plus the fiber and sugar-alcohol
discrepancies land well inside that band, while a genuine mislabelled
catalog entry falls back to hiding the % labels rather than displaying
a fabricated split that does not sum to 100).

The donut is pure inline SVG (no new runtime deps, per the standing
rule "No new runtime deps without surfacing the trade-off first"): an
SVG `<circle>`-suite with `stroke-dasharray` arcs — the same cheap,
tokenised, animated-on-hover pattern the pasted reference uses
(`viewBox="0 0 42 42"` trick). Center label: `Math.round(energy) kcal`
(the same number the detail already shows, per ADR-0004). The three
macro hues are NEW DESIGN.md tokens (`nutrition-protein` /
`nutrition-carbs` / `nutrition-fat`, see §tokens below).

### 4. Color is semantic, not decorative (ADR-0036 discipline)

The three macro hues are NEW tokens in DESIGN.md's colors block
(planned: protein `#7C4DBE`-family, carbs `#0E7490`-family, fats
`#B38F1F`-family, dark `*-soft` counterparts mirroring the existing
`nutrition-energy`/`nutrition-sodium` pattern). They are consumed with
literal Tailwind class names per the ADR-0036 rule, mirrored into
`@theme` + the `.dark` flip block, parity-tested in `palette.test.ts`,
and DESIGN.tokens.json regenerated with `@google/design.md export`.
No raw hex in any component.

**Values finalised (2026-10-01).** protein `#7C4DBE` / soft `#C4A8F5`;
carbs `#0E7490` / soft `#5CC0D8`; fat **`#7A5F0C`** / soft `#E8C86A`. The
drafted fat value `#B38F1F` measured **2.62:1** on the light `primary-tint`
surface and was darkened within the same gold family; the shipped six
measure 4.92 / 4.59 / 5.19:1 on the four light surfaces and 6.77 / 6.59 /
8.51:1 on the four dark ones. No glyph and no `IconRole` were added — the
three hues are donut-arc/legend identities and the legend WORD is the name.


### 5. Data access pattern for the doc

`RecipeDetail` already loads the full `doc` (`getRecipe`); the modal is
rendered from that in-memory doc — no new fetches, no new deps, nothing
external. The modal is a `RecipeDetail` child component fed `doc.nutrition`
+ `meta.calories`, with the doc-absent fallback (doc not loaded)
rendering the same skeleton the detail itself shows.

### 6. Scope: coerce the rich detail into the existing density

The macro bars currently on the detail remain visible in the section
(their e2e assertions stay). The modal ADDS:
- the donut + % legend (top area, `data-test="nutrition-donut"`),
- the grouped rows (each group a labelled `<details>`-like disclosure or
  plain labelled rows — implementer chooses per DESIGN.md density),
- a per-serving footer.

The modals' e2e guards: opens/closes, donut renders with the macro %
labels summing to ~100 (±1 rounding), sodium row shows the known value,
0 external requests. The existing nutrition-section e2e keeps its pin
(nutrition after detail-actions, sodium hue) BY CONSTRUCTION.

## Alternatives considered

- **A chart library (Chart.js, ECharts) for the donut.** Rejected: one
  donut is ~30 lines of inline SVG; a chart runtime costs bundle weight
  for one visualisation, violating the busy offline design contract.
- **Scale nutrition by servings.** Rejected — ADR-0004: nutrition facts
  are per serving; the doc values are per serving; totals scale but
  facts do not; the modal heading says "per serving" explicitly.
- **Show ALL nutrient groups expanded.** Rejected: 59 rows after a
  single tap is a wall; the modal groups them (macronutrients expanded,
  amino acids and trace minerals collapsed by default).
- **Render the donut without computing % (static thirds).** Rejected:
  the reference clearly communicates the percent-of-calories story;
  thirds without derivation would be a decorative lie.

## Consequences

- One more modal component in RecipeDetail; no router change, no store
  change, no persisted state.
- `doc.nutrition` finally feeds the catalog's full data to this surface
  (previously only its energy and sodium were consumed, via
  `meta.calories`/`meta.sodium_mg`).
- DESIGN.md/@theme/.dark/palette.test.ts grow by six tokens (3 hues ×
  light+dark); DESIGN.tokens.json regenerated in the same commit
  (standing token-pair rule).
- The e2e "nutrition visible after actions" pins survive unchanged —
  the modal triggers sit INSIDE the section, not around it.
