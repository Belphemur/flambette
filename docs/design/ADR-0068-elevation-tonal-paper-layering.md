# ADR-0068: Elevation — tonal paper layering + scoped modal blur

**Status:** Accepted (2026-10-09)
**Amends:** the no-backdrop-blur rule with one scoped exception
**Companions:** ADR-0067 (colour values), `docs/EXPERIENCE.md` §3

## Context

The Stitch design system replaces shadow-based elevation with tonal paper
layering: cards are index cards resting on a counter — separated by fill
tone and a 1px keyline, never floating on shadows. The one place depth is
real (a modal over a page) earns a scrim and a blur. The repo currently
forbids backdrop blur globally; this record scopes the single exception.

## Decision

Four levels, mirroring the design system:

- **Level 0 — canvas:** `surface` `#FBF8F2`.
- **Level 1 — cards/modules:** `surface-raised` `#F4EFE6`, 1px `border`
  keyline, 12px radius, **no drop shadow**. Hover strengthens the keyline
  (desktop, `hovercap:`-gated only) — it never lifts.
- **Level 2 — popovers/sticky bars:** white (`#FFFFFF`) + the ONE warm
  shadow `0 8px 24px -4px rgba(43,30,26,0.08)`. This is the only shadow
  in the app.
- **Level 3 — modals/sheets:** white sheet over the **espresso scrim
  `rgba(33,22,19,0.45)` + `backdrop-filter: blur(6px)`** — the explicit,
  scoped exception to the no-global-blur rule; plain page backgrounds
  never blur.

## Consequences

- The `.dark` block re-points each level's variables; every affected pair
  re-measured (WCAG text/keyline gates per the standing procedure).
- Checklist boxes: 20px, 6px radius, `border-strong` keyline; checked =
  the **`success` family** with `on-success` glyph, struck + muted text.
  (Amended 2026-10-09 by ADR-0072: a COMPLETION is never a food hue and
  never brand — tomato is spent on start intents. DESIGN.md's Checklists
  section is the current authority; ADR-0072 lists the few call sites
  that are NOT completions.)
- Reduced-motion has nothing to disarm: the blur is static, never animated.
- Cards rendered with `shadow-*` utilities anywhere in `src/` are a bug
  after the migration slice lands.
