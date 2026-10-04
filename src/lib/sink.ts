/**
 * Checked-rows sink for the shopping screen (ADR-0008 + ADR-0050 addendum).
 *
 * A completed row sinks below the open ones so the next row to tap is
 * always at the top of its group. This used to live as an inline
 * `.sort(...)` inside ShopView's store-section `v-for` — knowledge the
 * extras sub-sections needed too, so it is extracted here (DRY): ONE
 * ordering rule for every group on `/shop`, unit-tested, instead of a
 * second sort expression drifting beside the first.
 *
 * The partition is a single pass, so stability is guaranteed by
 * CONSTRUCTION (each group keeps its input order) rather than by leaning
 * on `Array.prototype.sort`'s engine-guaranteed stability over a
 * `flatMap`-built copy — and the result is always a NEW array; the input
 * is never mutated.
 */

/** Sink checked rows to the bottom, stable within each partition. */
export function sinkChecked<T>(rows: readonly T[], isChecked: (row: T) => boolean): T[] {
  const open: T[] = []
  const done: T[] = []
  for (const row of rows) {
    ;(isChecked(row) ? done : open).push(row)
  }
  return [...open, ...done]
}