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
| `border-strong` (control keyline) | `#8C7A6B` | measured pick from Stitch's `#D3C4B0`–`#C9B8A4` family, ≥3:1 against `surface-raised` |
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
