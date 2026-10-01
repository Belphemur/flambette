import { computed } from 'vue'
import { usePlanStore, type CookedEntry } from '../stores/plan'

/**
 * Read-side selectors over the plan store's cooked history (ADR-0011,
 * shared with the room by default since ADR-0032). The store rows are one
 * per cook EVENT; aggregating into per-recipe rows (count + last date)
 * happens here, never in a view.
 */

/** One aggregated history row: a recipe and how often it was cooked. */
export interface HistoryEntry {
  variantId: number
  count: number
  /** Timestamp of the most recent cook. */
  lastAt: number
}

/** Aggregate raw cook events into per-variant rows, most recent first. */
export function aggregateHistory(events: CookedEntry[]): HistoryEntry[] {
  const byVariant = new Map<number, HistoryEntry>()
  for (const e of events) {
    const row = byVariant.get(e.variantId)
    if (row) {
      row.count += 1
      row.lastAt = Math.max(row.lastAt, e.cookedAt)
    } else {
      byVariant.set(e.variantId, { variantId: e.variantId, count: 1, lastAt: e.cookedAt })
    }
  }
  return [...byVariant.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** How many times this variant was cooked (this device + the room). */
export function cookCount(events: CookedEntry[], variantId: number): number {
  let n = 0
  for (const e of events) if (e.variantId === variantId) n += 1
  return n
}

/** Timestamp of the most recent cook of this variant, or null if never. */
export function lastCooked(events: CookedEntry[], variantId: number): number | null {
  let last: number | null = null
  for (const e of events) {
    if (e.variantId === variantId && (last === null || e.cookedAt > last)) last = e.cookedAt
  }
  return last
}

/** Bind the selectors to the live plan store (reactive). */
export function useCookHistory() {
  const plan = usePlanStore()
  return {
    /** Aggregated per-recipe rows, most recent first. */
    historyEntries: computed(() => aggregateHistory(plan.cookedHistory)),
    count: (variantId: number) => cookCount(plan.cookedHistory, variantId),
    last: (variantId: number) => lastCooked(plan.cookedHistory, variantId),
  }
}

/* ---------- Formatting ---------- */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const DIVISIONS: { ms: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { ms: 60_000, unit: 'minute' },
  { ms: 3_600_000, unit: 'hour' },
  { ms: 86_400_000, unit: 'day' },
  { ms: 604_800_000, unit: 'week' },
  { ms: 2_592_000_000, unit: 'month' },
  { ms: 31_536_000_000, unit: 'year' },
]

/** "2 days ago" style relative time (auto granularity). */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now
  if (Math.abs(diff) < 45_000) return 'just now'
  for (const { ms, unit } of DIVISIONS) {
    if (Math.abs(diff) < ms || unit === 'year') {
      return rtf.format(Math.round(diff / ms), unit)
    }
  }
  return rtf.format(Math.round(diff / 31_536_000_000), 'year')
}

/** Absolute timestamp for tooltips / tap-to-reveal ("title" attr). */
export function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
