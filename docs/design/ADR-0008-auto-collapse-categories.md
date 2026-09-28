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
- **ShopView originally kept manual-only collapse** (plus
  checked-sink sorting): during active shopping, items re-checked
  wrongly are common, and auto-collapse would yank the list around
  mid-trip.

## Addendum (2026-09-28, v0.9.1) — auto-collapse extended to ShopView

The scope above is **amended, not reversed**. The reference screenshot
of the shopping screen shows a collapsed Produce section — a category
the user has just worked through — and that is exactly the state the
grocery tab has been collapsing for months. Waiting for the trip to end
to reclaim the space was the wrong trade: in the shop the list is
scrolled, a completed category is the most expensive thing on screen,
and the "mis-tap mid-trip" worry is answered by the same escape hatch
the grocery tab already has (see below), not by never collapsing.

- **ShopView now runs the same watcher contract as GroceryTab**: a
  section whose lines are all checked collapses on the false→true
  transition; unchecking any line re-expands (true→false). Collapse
  state is transition-driven, not count-driven.
- **Ordering: collapse is the LAST step of the checked sink.** In
  ShopView, checking a line re-sorts its group (checked items sink to
  the bottom). The collapse watcher runs `flush: 'post'`, so the sink
  re-render lands first and the group hides afterwards — the header
  reads its running `N/N` for a frame before the rows disappear,
  instead of the group vanishing mid-sink and re-expanding into a
  half-settled order.
- **The header survives the collapse**: chevron + an `N/N` count pill
  stay visible, with the grocery tab's `aria-label` contract
  (`<Section>: X of Y checked`) and `aria-expanded` state. Selectors
  mirror the grocery tab: `shop-section`, `shop-section-toggle`,
  `shop-section-rows`, `section-count-pill`.
- **The escape hatch is unchanged**: auto-collapsed state is a
  *separate* set from the manual one, and clicking a header clears both
  — a mis-tap is one tap to undo, on either screen.
- **Extra items stay manual-only.** The ShopView extras group is the
  user's scratch pad and is usually one or two rows; auto-collapsing a
  one-item group the moment it is checked is the exact yank ADR-0008
  was written to avoid.

## Consequences

- e2e must `click()` checkboxes whose check triggers a collapse (the
  input detaches), and only iterate `:not(:checked)` boxes.
- The cleared-empty state (ADR-0005) is orthogonal and unchanged.

## Alternatives considered

- **Auto-collapse everywhere including ShopView** — rejected *when this
  ADR was written*; **accepted in the addendum above** once the
  reference screenshot and the shared escape hatch settled it.
- **Sink checked items instead** — already in ShopView; insufficient
  alone for the grocery tab's long lists.
