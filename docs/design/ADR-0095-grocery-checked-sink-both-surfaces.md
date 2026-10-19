# ADR-0095: Checked grocery rows sink to the end of their category on both surfaces

Status: accepted (2026-10-19)

## Context

ADR-0071 ruled the Grocery tab a reading surface: a checked row stayed
where it was, struck through, while the Shopping surface (`ShopView`)
sank completed rows below the open ones via the shared `sinkChecked`
lib (`src/lib/sink.ts`). The split was deliberate — the reading-surface
fork was adopted so a checked row could be un-checked exactly where the
reader's eye left it — but in use the asymmetry itself became the bug:
the owner hit a case on `/grocery` where a checked row scrolled out of
reach while unchecked siblings stayed high in the category, and the
"next tap is always at the top" property the sink guarantees on
Shopping did not hold on Grocery. The owner ruled (2026-10-19):
"checking an item needs to make it go to the end of its category
automatically — basically we had a sort that checked items are lower
than unchecked ones" — and clarified the rule applies to BOTH shopping
and grocery lists.

## Decision

Checked rows sink to the end of their category on BOTH surfaces. The
Grocery tab restores the `sinkChecked` projection inside its section
row list (the same stable-within-group ordering ShopView uses), so
`/grocery` and `/shop` share one checked-row behaviour again. The sink
remains the ONE shared `sinkChecked` lib; its sort is never re-spelled
per surface (the topic rule in `docs/agents/grocery-and-extras.md`
already states the lib is shared by both surfaces — this record makes
the behavioural claim match the code).

Strikethrough + muted styling for checked rows is unchanged; only the
ORDER changes. Auto-collapse (ADR-0008 + addendum) is untouched and
remains the last step after the sink re-sort.

## Consequences

- The "next tap is at the top of its group" property now holds on both
  surfaces; a checked row can still be un-checked, from the bottom of
  its category instead of in place.
- ADR-0071's delta 1 (checked-in-place on Grocery) is no longer in
  force; its other deltas are unaffected.
- Grocery e2e specs assert checked-last ordering within a category;
  the ADR-0071-era in-place ordering assertions are rewritten.
- `sink.test.ts` is unchanged — the lib's behaviour never moved.

## Alternatives considered

- **Keep the split, fix reachability only** (e.g. scroll-to-checked):
  rejected — two orderings for the same semantic ("this item is done")
  across two surfaces of the same list is the confusion the owner is
  removing, and scrolling does not restore the next-tap-at-top
  property.
- **Checked rows disappear from the category entirely** (a "done"
  drawer): rejected — the strikethrough row is the undo affordance;
  hiding it trades a visibility bug for an un-check discoverability
  bug.

This record supersedes ADR-0071 in part (delta 1, checked-in-place on
the Grocery tab). Implemented in PR #98.
