# ADR-0075: The Stitch grammar is one contract — cross-surface consistency sweep

Status: accepted (2026-10-09)

## Context

The owner's ruling on the second composition pass (grocery, recipe
detail/cooking, explore): the new patterns must land as the app's
NORMATIVE grammar, verified on every surface — not as three local
redesigns. ADR-0071..0074 each decide one surface; this record makes
the SHARED patterns enforceable and orders the consistency pass that
closes the gap on the surfaces those ADRs don't touch (Plan, History,
Settings, Shop).

pi workers have direct Stitch MCP access (project "Flambette Recipe
App") and MUST read the target screens from the project during their
slice — the renders are the visual authority, the ADRs the behavioural
one, DESIGN.md the token one.

## Decision — the grammar inventory

Every surface adopts the same five grammar rules; a surface that can't
apply one says why in its own ADR/section:

1. **Editorial header block** (ADR-0065 lineage): eyebrow → H1 →
   derived-from subtitle with REAL counts. Tab titles stop being bare;
   the subtitle is built from the surface's own state (grocery: N
   meals/M servings; plan: N meals; history: cooks in range; explore:
   title only — no invented copy).
2. **Section = index card** (ADR-0071): grouped lists render rows
   inside ONE rounded `surface-raised` card with keyline dividers and
   a header BAND carrying the group's food-hue glyph, name, and mono
   count pill; aisle numbering where the order is a walk order.
3. **Quantity = the data voice** (ADR-0071/0073): display quantities
   render as right-aligned JetBrains Mono badges; tabular numbers
   everywhere (§4).
4. **Completion = success family** (ADR-0072): grocery/shop checkboxes,
   complete pills, Finish cooking.
5. **Real data only** (standing rule, now explicit): every render
   fiction is rejected at adoption time and LISTED in the adopting
   ADR's rejected-fictions section — never copied, never approximated.

## The sweep (final slice)

A dedicated implementation slice walks ALL surfaces against this
inventory and the Stitch screens, including the surfaces ADR-0071..0074
do not restructure:

- **ShopView**: adopts header-band + aisle-number + qty-badge +
  success-checkbox grammar; KEEPS the sink, chromeless room, ≥52px
  rows, auto-collapsed done aisles (ADR-0071's task-surface ruling).
- **Plan / Auto-Plan**: editorial header; meal rows adopt the mono
  facts grammar; the share-history toggle stays a preference control
  (ADR-0072's non-completion list).
- **History / Settings**: editorial headers; mono counts already in
  place (slice 6) — verify, don't restyle; nothing fabricated.
- **Explore + detail + cooking + grocery**: per ADR-0074 / 0073 / 0071.
- **Cross-cutting**: room pill appears ONCE per surface (header chip or
  strip, never both); dark mode rides the flip tokens only.

Deliverables: the sweep commits the updated `contrast_sweep` table
(success pairs + new surfaces), refreshed boards (both themes, all
surfaces, re-inspected), and a consistency checklist in the report —
each grammar rule × each surface, pass/fail with file:line evidence.

## Consequences

- The report's checklist becomes the owner's acceptance artefact; a
  rule marked failed without an ADR-cited reason reopens the slice.
- EXPERIENCE §6/§7 are amended in the same commit (grammar inventory
  reflected in the component language and walkthroughs).
- No new stores, routes, or payload members beyond ADR-0071..0074's
  allowances; §8's "what does NOT change" list still holds.

## Alternatives considered

- **Per-surface ADRs only, no sweep**: rejected — that is how slice-5
  shipped a different checkbox colour from slice-6's pills; the drift
  was caught by hand. The contract + sweep make it structural.
- **Lint/test-enforced grammar** (custom ESLint rules on class names):
  not now — the boards + checklist give the owner the visual word;
  mechanical enforcement is a follow-up if drift recurs.
