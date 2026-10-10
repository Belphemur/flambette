# ADR-0069: Chip treatment — always-tinted dietary chips (amendment to ADR-0036)

**Status:** Accepted (2026-10-09)
**Amends:** ADR-0036 (chip colour semantics)
**Companions:** ADR-0067 (values), ADR-0027/0028 (QuickFilters — untouched)

## Context

The Stitch renders show dietary/protein chips tinted at rest — the food
hue IS the chip's identity in both states — while selection stays brand.
ADR-0036's tint-not-fill selection rule already half-states this; the
renders formalise the idle state and the pill geometry.

## Decision

1. Dietary/protein chips are **always tinted**: idle = 8% semantic hue
   tint + hue text (`rgba(hue, 0.08)` on paper) — the icon's hue and the
   chip's hue now agree at rest AND on hover.
2. **Selected = `primary-tint` background + `primary-strong` text.**
   Selection is always brand, never a filled food hue — ADR-0036's rule
   is unchanged; this record only adds the always-tinted idle state.
3. Exclusion diets (`no-pork`, `no-meat`, `no-shellfish`) keep their
   explicit wording; the tomato of "meat" alone is never the only signal.
4. The label never drops; an icon carrying state stays queryable
   (`aria-pressed`).
5. Pill geometry (9999px, `0.25rem × 0.75rem` padding) becomes the
   standard for all filter, period and aisle-count pills app-wide.

## Consequences

- `quickFilters.ts` is untouched — this is presentation only; every
  inbound value still goes through `normalizeQuickFilters`.
- ADR-0036 remains authoritative for the two-family separation (food
  hues vs nutrition semantics) and the tint-not-fill selection rule.
- Selected tint must stay ≥4.5:1 on both themes (the existing
  `primary-strong` pair already qualifies).
