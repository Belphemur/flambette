# ADR-0008: Auto-collapse completed grocery categories (grocery tab only)

- **Status:** accepted
- **Date:** 2026-09-27 (v0.4.1)
- **Decides:** collapse behavior of grocery store sections

## Context

On a long list, checked-off categories waste scrolling space; the
owner asked for them to collapse automatically when fully done.

## Decision

- In **GroceryTab**, a store section with every line checked collapses
  automatically on the false→true transition; unchecking any item
  re-expands (true→false). Header + a done/total count pill stay
  visible on the collapsed section.
- Collapse state is transition-driven, not count-driven (plan edits
  that change which meals are planned don't fight the user); a
  separate manual-collapse set is preserved so auto logic never
  re-opens what the user closed; clicking an auto-collapsed header
  clears both sets.
- **ShopView deliberately keeps manual-only collapse** (plus
  checked-sink sorting): during active shopping, items re-checked
  wrongly are common, and auto-collapse would yank the list around
  mid-trip.

## Consequences

- e2e must `click()` checkboxes whose check triggers a collapse (the
  input detaches), and only iterate `:not(:checked)` boxes.
- The cleared-empty state (ADR-0005) is orthogonal and unchanged.

## Alternatives considered

- **Auto-collapse everywhere including ShopView** — rejected: fights
  the interactive shopping flow.
- **Sink checked items instead** — already in ShopView; insufficient
  alone for the grocery tab's long lists.
