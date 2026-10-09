# ADR-0067: Colour — adopt the Warm Culinary Paper values (token names kept)

**Status:** Accepted (2026-10-09)
**Companions:** ADR-0036 (hue registry — unchanged), `docs/EXPERIENCE.md` §3, ADR-0068 (elevation)

## Context

Owner ruling after reviewing the Stitch renders: adopt the "Warm Culinary
Paper" colouring. Repo components already consume semantic token names
(`bg-surface`, `bg-surface-raised`, `border`, `text-muted`…), so the
migration is a VALUE re-point in DESIGN.md + the `@theme` block + the
`.dark` flip — not a component rewrite. Tailwind never scans hex values,
only class names, which is what makes this cheap.

## Decision

| Repo token | Old | New (Stitch) |
|---|---|---|
| `surface` (page) | `#FFF8F0` | `#FBF8F2` paper-base |
| `surface-raised` (cards) | `#FFFFFF` | `#F4EFE6` paper card |
| `surface-sunken` (bands/fields) | `#FFF0E6` | `#EDE5D8` paper-elevated |
| `border` | `#E5D8CB` | `#E3D8C8` border-warm |
| `border-strong` (control keyline) | `#8C7A6B` | **`#947E64`** — measured pick, see the record below |
| `text` | `#292524` | `#1C1C18` on-surface |
| `text-muted` | `#63574E` | `#59413C` on-surface-variant |
| `brand` / `brand-*` | — | unchanged (`#B3381F` / `#8E2C17`) |
| all four `hue-*` food families | — | unchanged, byte for byte |

New families, each added only with a measured dark pair (WCAG ≥4.5:1 text /
≥3:1 keyline, ΔE separation from neighbours — the established hue-collision
procedure, never hand-picked):

- **Saffron `#D97706` + soft** — timers, heat, culinary tips. A non-food
  family; measured against `warning #9A3412` and `meal-breakfast #946200`.
- **Roasted espresso `#2B1E1A`** — the SECONDARY chrome surface:
  bottom-nav bar and photo-scrim discs in BOTH themes (dark chrome in
  light mode, as every reviewed render shows).
- **Popover white + warm ambient shadow** and **espresso modal scrim** —
  see ADR-0068.

## Consequences

- Dark mode keeps the `.dark` variable-flip architecture (ADR-0036); its
  ramps re-tune to the new paper and every affected pair re-measured.
- `palette.test.ts` gains the new families; the DESIGN.md ↔ `@theme`
  parity gate must stay green on both themes.
- Stitch renders that echo our OLD hexes (`#FFF8F0`, `#E5D8CB`) in their
  generated CSS are ignored — this table is authoritative where a render
  disagrees.
- Sodium warm-grey (`#9FA9A3` in one render) is NOT adopted; sodium
  imagery stays off cards per the existing convention.

## Measured record (filled in at the migration slice, 2026-10-09)

**`border-strong` = `#947E64`.** WCAG sRGB contrast of the family endpoints against
the adopted paper card `#F4EFE6`: `#D3C4B0` **1.49:1**, `#C9B8A4` **1.69:1** — the
entire Stitch family sits far below the 3:1 non-text gate on any paper surface
(best member vs the page: 1.82:1). The pick therefore extends the family along its
warm-tan hue line down to the first value that clears the gate on BOTH the contexts
the keyline actually lives in: **`#947E64`** measures **3.38:1** against
`surface-raised`, **3.10:1** against the sunken field well `#EDE5D8`, and **3.65:1**
against the page — all ≥ 3:1. (The next-darker neighbour `#9C8670` passes the card
bar at 3.03:1 but misses the well at 2.77:1.) The dark counterpart
`border-dark-strong #A28E80` is unchanged and re-measured green: **4.69:1** on
`surface-dark-sunken`, **5.36:1** on `surface-dark-raised`.

Other measured pairs locked by this adoption (light surfaces are page / card /
sunken well):

- Core text: `text #1C1C18` **16.12 / 14.92 / 13.67:1**; `text-muted #59413C`
  **8.82 / 8.16 / 7.48:1**; `primary-strong` as text **7.85 / 7.27 / 6.66:1**.
  The field focus keyline (`primary-strong` on the well) is **6.66:1** light and
  **5.97:1** dark (`primary-soft` on `surface-dark-sunken`) — ADR-0065's numbers,
  confirmed on the adopted values.
- Saffron `#D97706`: **3.01:1** on the page — a graphic/large-numeral colour (timer
  digits are ≥ 20px mono, so the 3:1 large-text bar applies); it measures **2.78:1**
  on `surface-raised`, so saffron glyphs ride on the page or a saffron tint, never
  bare on cards. `saffron-soft #FCD34D` is **11.61:1** on `surface-dark-raised`.
  ΔE (CIEDE2000) from neighbours: `warning` 27.3, `meal-breakfast` 19.3,
  `nutrition-energy` 22.3, `meal-snack` 21.1, `nutrition-fat` 29.5. The one tight
  neighbour is `meal-breakfast-soft` (ΔE 8.4) — every amber in the space sits
  within 6–9 of one gold neighbour; accepted on non-co-occurrence (timers never
  share a surface with the breakfast meal-type chip) plus the glyph/label second
  signal.
- Espresso `#2B1E1A` + dark pair `#1E1512`: ΔE 21.1 from `meal-dinner`, 11.8 from
  `text`. Chrome foregrounds on the bar: `chrome-muted #C7B5A6` **8.12:1** (light
  chrome) / **9.04:1** (dark chrome); active backplate `#FBEAE5` separates at
  **13.81:1** with `chrome-backplate-text #8E2C17` on it at **7.14:1**; hover
  accent `#F08A6A` **6.56:1**; top edge `chrome-border #A28E80` **5.15:1**.
- Popover `#FFFFFF` carries `text` at **17.09:1**; `popover-dark #2C231E` carries
  `text-dark` at **14.59:1**.
- Hue families are byte-for-byte unchanged but re-measured on the new paper: the
  six food/nutrition foregrounds are ≥ 4.29:1 (worst: `hue-fish` on the sunken
  well) and ≥ 4.5:1 on page and card; dark counterparts ≥ 5.64:1. The dark ramps
  are kept — they already sit in the espresso family and every dark pair measured
  green on the existing values.
- ONE value changed outside the table: `favourite` `#E11D48` → **`#C9183C`**. On
  the adopted paper card the old rose measured **4.10:1** as the favourite-filter
  chip text — below the 4.5:1 text bar the design.md lint gate enforces (it was
  already 4.46:1 on the old white card). The new rose clears 4.5:1 on ALL four
  light contexts (page 5.38, card 4.98, well 4.57, self-tint 4.72), ΔE 5.5 from
  the old value (same identity, slightly deeper) and ΔE 7.5 from `danger`. The
  `favourite-soft` heart FILL is unchanged.
