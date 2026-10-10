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

/**
 * Every cook EVENT of one variant, newest first (ADR-0034). The count
 * line answers "how often"; this answers "when exactly", which a
 * per-variant aggregate has thrown away.
 */
export function cookEventsFor(events: CookedEntry[], variantId: number): number[] {
  return events
    .filter((e) => e.variantId === variantId)
    .map((e) => e.cookedAt)
    .sort((a, b) => b - a)
}

/* ---------- Plan provenance (ADR-0034) ---------- */

/**
 * One plan's worth of cook events, derived on the read side. Storage is
 * NOT multiplied: a cook event belongs to exactly ONE plan and carries only
 * that plan's id + creation time, so a plan's membership stays recoverable
 * from the plan itself and the history cannot drift away from it.
 */
export interface PlanHistoryGroup {
  /** The plan's stable id, or null for rows written before ADR-0034. */
  planId: string | null
  /** When the plan was put together, or null for legacy rows. */
  planCreatedAt: number | null
  /** Most recent cook in the group — the sort key fallback. */
  lastAt: number
  events: CookedEntry[]
  /** Per-recipe rows for this group, most recent first. */
  entries: HistoryEntry[]
}

/** Group key for rows that carry no plan identity (older peers/backups). */
const LEGACY_GROUP_KEY = '\u0000legacy'

/**
 * Group cook events by the plan they were cooked under, most recent plan
 * first. Events without a plan id (written by an older peer, or imported
 * from an older backup) collapse into a single trailing "earlier cooks"
 * group rather than being dropped or faked into a plan.
 */
export function groupHistoryByPlan(events: CookedEntry[]): PlanHistoryGroup[] {
  const byPlan = new Map<string, PlanHistoryGroup>()
  for (const e of events) {
    const key = e.planId ?? LEGACY_GROUP_KEY
    let group = byPlan.get(key)
    if (!group) {
      group = {
        planId: e.planId ?? null,
        planCreatedAt: Number.isFinite(e.planCreatedAt as number) ? (e.planCreatedAt as number) : null,
        lastAt: e.cookedAt,
        events: [],
        entries: [],
      }
      byPlan.set(key, group)
    }
    group.events.push(e)
    group.lastAt = Math.max(group.lastAt, e.cookedAt)
  }
  for (const group of byPlan.values()) {
    group.events.sort((a, b) => b.cookedAt - a.cookedAt)
    group.entries = aggregateHistory(group.events)
  }
  return [...byPlan.values()].sort(
    (a, b) =>
      (b.planCreatedAt ?? b.lastAt) - (a.planCreatedAt ?? a.lastAt) || b.lastAt - a.lastAt,
  )
}

/* ---------- Period window + summary (EXPERIENCE.md §7, History) ---------- */

/**
 * The cook events inside the last `days` days, or ALL events when `days`
 * is null. A read-side window over the same events — nothing is filtered
 * in storage and the grouping below re-derives from the window, so the
 * period pills (All time / Past 30 days / Past 90 days) can never lose a
 * cook: they only choose which slice the tab shows. `now` is injectable
 * so the cutoff is testable without a clock mock.
 */
export function filterHistoryEvents(
  events: CookedEntry[],
  days: number | null,
  now: number = Date.now(),
): CookedEntry[] {
  if (days === null) return events
  const cutoff = now - days * 86_400_000
  return events.filter((e) => e.cookedAt >= cutoff)
}

/** The three DATA numbers the history head states for the chosen window. */
export interface HistorySummary {
  /** Cook events in the window (a recipe cooked twice counts twice). */
  total: number
  /** Distinct recipes in the window. */
  dishes: number
  /** Most recent cook in the window, or null when the window is empty. */
  lastAt: number | null
}

/** Summarize a slice of cook events — total, distinct dishes, most recent. */
export function summarizeHistory(events: CookedEntry[]): HistorySummary {
  const dishes = new Set<number>()
  let lastAt: number | null = null
  for (const e of events) {
    dishes.add(e.variantId)
    if (lastAt === null || e.cookedAt > lastAt) lastAt = e.cookedAt
  }
  return { total: events.length, dishes: dishes.size, lastAt }
}

/** Bind the selectors to the live plan store (reactive). */
export function useCookHistory() {
  const plan = usePlanStore()
  return {
    /** Aggregated per-recipe rows, most recent first. */
    historyEntries: computed(() => aggregateHistory(plan.cookedHistory)),
    /** The same events grouped by the plan they were cooked under. */
    planGroups: computed(() => groupHistoryByPlan(plan.cookedHistory)),
    count: (variantId: number) => cookCount(plan.cookedHistory, variantId),
    last: (variantId: number) => lastCooked(plan.cookedHistory, variantId),
    events: (variantId: number) => cookEventsFor(plan.cookedHistory, variantId),
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
