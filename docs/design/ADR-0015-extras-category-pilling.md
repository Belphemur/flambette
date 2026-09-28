# ADR-0015: Extras live in EXTRA ITEMS with a category tag — never routed

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0014 (bulk add flow), ADR-0012 (ingredient-index
categories), ADR-0003 (derived grocery sections). Nothing is superseded:
the add flow, the suggestion source and the derived section aggregation
are unchanged.

## Context

The bulk-add flow (ADR-0014) appends free-form items that belong to no
planned meal to `plan.customItems` — the "Extra" bucket. ADR-0012 gave
every add a store category (index match, remembered pick, or `Other`),
and v0.9.0 rendered that category as a small chip on the extra row.

The reference screenshots showed two things we had wrong:

- the category was rendered as a *category chip* that read like a
  destination ("Produce") even though the item never moved anywhere,
  and it was rendered even for `Other`, i.e. for the *absence* of a
  category; and
- the group the extras live in was not a first-class group: the add-row
  floated above an unlabelled block, so the extras read as a stray list
  between the add bar and the first store section.

The obvious "fix" — routing an extra into its category section — is
wrong for this app. The category comes from an ingredient index built
from recipe text, not from a shopping context, and the two routinely
disagree: produce bought for a stew belongs in Produce by category but
the user may be walking one aisle in a specific order; "frozen" appears
as a prefix of many items; the user may deliberately park an item in
extras to buy it last, or on a different day, or not at all.

## Decision

1. **Extras live in the EXTRA ITEMS static group.** A free-form add is
   an "Extra" and stays in that group: a plain header, no chevron, no
   collapse, no count-driven reordering. The group renders **first** on
   the Grocery tab — above Produce and every other store section — with
   the add-row anchored directly under its header, so the add bar and
   the things it creates are one visual unit.
2. **A known category is a TAG, never a move.** When the extra has a
   known category (ingredient-index match, or the explicit pick in the
   add form) the row renders a small category-tag pill reading that
   category (`#Produce`, `#Household`) beside the name. The item stays
   in EXTRA ITEMS; the tag is a label, not a destination. Nothing in
   the aggregation path (`src/lib/useGroceryList.ts`, `src/lib/grocery.ts`)
   reads it — extras never join a store section.
3. **`Other` is the absence of a category, not a category.** An extra
   whose remembered bucket is `Other` (or which has no memory at all)
   renders exactly as before: a plain row, no tag. Existing extras
   without a known category are therefore unchanged by this ADR.
4. **The tag is a flex sibling OUTSIDE the truncating name span**
   (`shrink-0`), so a long name truncates and the tag is never clipped
   or crowded against the checkbox (same rule as the provenance pill,
   AGENTS.md).
5. The tag carries an `aria-label` naming the category and stating that
   the row stays in Extra items, so a screen reader does not read it as
   a section move.

Selectors (data-test): `extra-section`, `extra-row`,
`extra-item-category-tag` (replacing `custom-items` and
`custom-item-category`).

## Consequences

- The Grocery tab's first child is the extras group; specs that assume
  the first `[data-test=grocery-section]` is the first group on screen
  must compare against `[data-test=extra-section]` explicitly.
- A category is metadata about an extra, never a routing instruction.
  If we later want sorted-by-category shopping, that is a *view* of
  extras the user can invoke, not a mutation of where they live.
- ShopView's extras group stays manual-collapse-only (ADR-0008
  addendum): a one-item extra that auto-hid itself on a mis-tap would
  yank the list mid-trip.

## Alternatives considered

- **Route extras into their category section** — rejected: it removes
  the user's manual control of placement, and the index category is a
  text-derived guess, not a shopping decision.
- **Keep the chip for `Other` too, reading "Other"** — rejected: it
  labels the unknown case as if it were knowledge, and it is what v0.9.0
  screenshotted as confusing.
- **Make the extras group collapsible like the store sections** —
  rejected: it is a small static scratch pad; a chevron there implies a
  body of items that never appears.
