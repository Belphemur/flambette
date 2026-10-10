# ADR-0076: Department hues for every grocery category

Status: accepted (2026-10-09)

## Context

The grocery reading surface (ADR-0071) renders every store section as an
aisle index card: a leading glyph, the section name, the derived
`(Aisle N)` index and the mono `N/M` pill. A first pass shipped glyphs
for all 31 `STORE_SECTIONS` (the owner's every-category ruling) but gave
only two of them a colour: Produce wore `hue-vegetarian` and Meat &
Seafood wore `hue-meat`, on the reasoning that those are the only two
departments whose identity the food-icon registry (ADR-0036) already
claims — every other department rendered its glyph in muted ink rather
than "borrow" a hue that already answers a different question.

The owner overruled the muted-ink default: **every category carries a
colour, like meat and produce**, sourced through the design doc
(DESIGN.md) — not per-component hand-picks. The constraint set is
therefore: reuse the food registry's tokens where the registry's
identity already covers the department; introduce a measured family for
the rest; keep every value ≥3:1 (WCAG non-text) on BOTH themes; keep
ΔE (CIEDE2000) separation from every existing semantic token; and keep
ADR-0036's colour-is-never-the-only-signal rule intact.

## Decision

1. **DESIGN.md gains an `aisle-*` family**: 14 measured light/dark token
   pairs covering the 29 departments whose identity the food registry
   does not already claim. Two departments REUSE registry tokens —
   Produce wears `hue-vegetarian`, Meat & Seafood wears `hue-meat` — so
   an aisle band and a protein chip can never disagree about what green
   or red means.
2. **Kindred departments deliberately ALIAS one token** (Deli & Specialty
   Cheese / Nut Butters, Honey & Jams / Pasta & Sauces share
   `aisle-gold`; Bakery / Baking & Spices / Pet Care share
   `aisle-crust`; and so on — the full table lives in DESIGN.md "Store
   department (aisle) hues"). An alias is ΔE 0 by design, not a
   collision: the glyph shape and the printed name carry identity inside
   the family, and the hue groups kindred aisles at a glance. Aliased
   sections are NEVER adjacent in `STORE_SECTIONS` order — pinned by a
   unit test — so a scan never sees two same-coloured bands in a row.
3. **The mapping lives in `src/lib/aisleRole.ts`**, one table of literal
   `text-*` utilities beside the glyph table (ADR-0036's one-registry
   rule). Tailwind scans source text for complete class names, so no
   class is interpolated; dark mode flips through the `.dark` variable
   re-pointing, never a `dark:` utility. The four call sites — grocery
   aisle bands, extras sub-section bands, the add-extra category picker
   (menu rows via `FilterDropdownOption.iconClass` and the closed
   trigger) and the autocomplete's per-row category pill — consume the
   one table; no component keeps its own icon→hue map.
4. **Aisle tokens never join the `IconRole` registry.** A department is a
   THIRD question beside "what kind of food" (categorical roles) and
   "what does this number mean" (semantic roles); `IconRole` stays
   closed, and no component consumes an `aisle-*` token outside the four
   grocery call sites. An aisle hue is also never a state: checked rows
   paint the `success` done state (ADR-0072), not the aisle hue.

**Measurement record** (per DESIGN.md's measured-palette contract):

- Every light value clears the 3:1 non-text bar on page, card AND sunken
  band — worst 3.13:1 (`aisle-ice` on the well). Every soft value clears
  3:1 on all three dark surfaces — worst 5.11:1.
- All 14 pairs sit ≥10 ΔE from every existing family EXCEPT seventeen
  pairs in the 8.0–9.9 band, all against the amber, violet and
  pastel-blue semantic tokens — the spaces DESIGN.md's saffron addendum
  already called fully occupied (which accepted a ΔE 8.4 pair on the
  same grounds). Every such token never co-occurs with the aisle band as
  a competing decision, and the glyph + printed name are the second
  signal.
- Aisle hues are decorative reinforcement beside a visible label:
  colour is never the only signal (ADR-0036).

## Consequences

- Every grocery department is coloured in both themes; the aisle list
  reads as a colour-coded index the way meat/produce already did.
- 28 new tokens ship in DESIGN.md, `src/style.css` (`@theme` + `.dark`
  flips), the generated `DESIGN.tokens.json` and the token-parity test's
  `COLOR_TOKENS` map — all four in lockstep or the whole-file parity
  test fails.
- The muted-ink branch is gone from the band call sites;
  `aisleRole()` (the hue-only read) is deleted — `aisleIcon()` returns
  `{ glyph, className }` and ShopView's band renders through it too, so
  the shopping screen's bands converge on the same grammar (ADR-0075
  rule 2).
- Adding a store section now requires an `aisleRole.ts` table entry
  (glyph + class) or the unit tests fail loudly — a missing colour is a
  build break, never a silent muted band.

## Alternatives considered

- **29 unique hues, one per department.** Rejected: 29 distinct mid-tones
  cannot all sit ≥10 ΔE from the existing ~30 semantic tokens AND each
  other — the palette already occupies every hue family densely, so
  "unique" degenerates into sub-8 ΔE near-collisions, which are worse
  than deliberate aliases (a near-miss reads as "the same but wrong").
- **Keep muted ink for non-food departments.** The previous behaviour;
  overruled by the owner — the bands read inconsistently when only two
  aisles are coloured.
- **Borrow meal-occasion hues** (breakfast amber for the Breakfast aisle,
  etc.). Rejected: those tokens already answer "which meal" on the same
  app (plan previews, recipe cards); one colour would carry two
  unrelated meanings, the exact collision ADR-0036 exists to prevent.
- **Render aisles through `HueIcon`/`IconRole`.** Rejected: that couples
  the department identity to the closed food/nutrition role registry and
  re-introduces the borrowed-hue problem this ADR resolves.
