/**
 * Checked-rows sink (ADR-0008 + ADR-0050 addendum).
 *
 * A completed row sinks below the open ones so the next row to tap is
 * always at the top of its group. The rule serves BOTH grocery surfaces:
 * Shop mode (where it has always lived) and — since the ADR-0071
 * delta-1 supersession (2026-10-19) — the Grocery tab's sections and
 * extras sub-sections too. The per-surface row projections
 * (`sinkedStoreRows`, `sinkedExtraRows`) live here as well, so the two
 * views cannot drift into second sort expressions.
 *
 * The partition is a single pass, so stability is guaranteed by
 * CONSTRUCTION (each group keeps its input order) rather than by leaning
 * on `Array.prototype.sort`'s engine-guaranteed stability over a
 * `flatMap`-built copy — and the result is always a NEW array; the input
 * is never mutated.
 */

import { extraCheckedKey } from './extraCheckedKeys'

/** Sink checked rows to the bottom, stable within each partition. */
export function sinkChecked<T>(rows: readonly T[], isChecked: (row: T) => boolean): T[] {
  const open: T[] = []
  const done: T[] = []
  for (const row of rows) {
    ;(isChecked(row) ? done : open).push(row)
  }
  return [...open, ...done]
}

/**
 * A store section's rows in SUNK order (ADR-0008): one row per grocery
 * line, the item carried beside its line for the row's name/provenance,
 * checked rows last, stable within each partition. ONE implementation for
 * both surfaces that render store sections (`ShopView` and `GroceryTab`)
 * — the inline sort this used to be in ShopView is the exact knowledge
 * the Grocery tab's sink needs, so it lives here (DRY), next to
 * `sinkChecked`, instead of drifting as a second sort expression.
 */
export function sinkedStoreRows<
  I extends {
    name: string
    lines: { key: string; text?: string; derivedText?: string; fallbackUnit?: string }[]
  },
>(section: { items: I[] }, checked: Record<string, boolean>) {
  return sinkChecked(
    section.items.flatMap((item) => item.lines.map((line) => ({ item, line }))),
    (e) => !!checked[e.line.key],
  )
}

/**
 * An extras sub-section's rows in SUNK order (ADR-0008 + ADR-0050): an
 * extra's checkbox key is derived from its NAME (`extraCheckedKey`), so
 * the sink reads the same done-map the row's checkbox does.
 */
export function sinkedExtraRows(
  group: { items: { name: string }[] },
  checked: Record<string, boolean>,
) {
  return sinkChecked(group.items, (i) => !!checked[extraCheckedKey(i.name)])
}
