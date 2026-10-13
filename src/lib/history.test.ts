import { describe, expect, test } from 'bun:test'
import {
  aggregateHistory,
  cookCount,
  cookedToday,
  cookEventsFor,
  filterHistoryEvents,
  groupHistoryByPlan,
  replanEntries,
  summarizeHistory,
} from './history'
import type { CookedEntry } from '../stores/plan'

/**
 * ADR-0034 — the read side of cook history. Two views over the SAME
 * events: a per-recipe aggregate (how often, when last) and a per-plan
 * grouping (which batch, when was it put together). Neither stores
 * anything, so the invariant worth pinning is that a group is exactly the
 * events that name its plan — including the legacy rows that name none.
 */

const event = (
  variantId: number,
  cookedAt: number,
  planId?: string,
  planCreatedAt?: number,
): CookedEntry => ({
  variantId,
  cookedAt,
  id: `${variantId}@${cookedAt}`,
  ...(planId !== undefined ? { planId, planCreatedAt } : {}),
})

describe('aggregateHistory (unchanged per-recipe view)', () => {
  test('counts every event and keeps the newest timestamp', () => {
    const rows = aggregateHistory([
      event(1, 10, 'p1', 1),
      event(1, 30, 'p1', 1),
      event(2, 20, 'p2', 5),
    ])
    expect(rows).toEqual([
      { variantId: 1, count: 2, lastAt: 30 },
      { variantId: 2, count: 1, lastAt: 20 },
    ])
  })
})

describe('cookEventsFor (the per-event spoiler)', () => {
  test('returns this recipe’s cook times, newest first, in order', () => {
    const events = [event(1, 10), event(2, 20), event(1, 30), event(1, 5)]
    expect(cookEventsFor(events, 1)).toEqual([30, 10, 5])
    expect(cookCount(events, 1)).toBe(3)
    expect(cookEventsFor(events, 3)).toEqual([])
  })
})

describe('groupHistoryByPlan (ADR-0034)', () => {
  test('groups by plan, newest plan first, and aggregates inside each group', () => {
    const groups = groupHistoryByPlan([
      event(1, 10, 'old', 1),
      event(2, 12, 'old', 1),
      event(1, 30, 'new', 20),
    ])
    expect(groups.map((g) => g.planId)).toEqual(['new', 'old'])
    expect(groups[1].entries).toEqual([
      { variantId: 2, count: 1, lastAt: 12 },
      { variantId: 1, count: 1, lastAt: 10 },
    ])
    expect(groups[1].events.map((e) => e.cookedAt)).toEqual([12, 10])
  })

  test('a recipe cooked in two plans appears in both groups, counted once each', () => {
    const groups = groupHistoryByPlan([event(1, 10, 'a', 1), event(1, 20, 'b', 5)])
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.entries[0].count === 1)).toBe(true)
  })

  test('rows with no plan id collapse into ONE legacy group, sorted by last cook', () => {
    const groups = groupHistoryByPlan([
      event(1, 10, 'p', 5),
      // A legacy row (older peer / older backup) and a row whose plan is
      // known but whose creation time is not (a peer payload the backup
      // validator would reject, but a live merge carries verbatim).
      event(2, 40),
      event(3, 30, 'q'),
    ])
    // Nothing to date either headless group by, so both sort on their last
    // cook; only the dated plan sorts on when it was put together.
    expect(groups.map((g) => g.planId)).toEqual([null, 'q', 'p'])
    const legacy = groups[0]
    expect(legacy.planCreatedAt).toBeNull()
    expect(legacy.entries.map((e) => e.variantId)).toEqual([2])
    expect(groups[1].planCreatedAt).toBeNull()
  })

  test('a planId with a non-numeric creation time still groups, without a date', () => {
    const groups = groupHistoryByPlan([{ variantId: 1, cookedAt: 5, planId: 'p', planCreatedAt: NaN }])
    expect(groups).toHaveLength(1)
    expect(groups[0].planId).toBe('p')
    expect(groups[0].planCreatedAt).toBeNull()
  })

  test('an empty history is an empty grouping (not one empty group)', () => {
    expect(groupHistoryByPlan([])).toEqual([])
  })
})

describe('filterHistoryEvents (the period pills)', () => {
  const NOW = 100 * 86_400_000 // day 100
  const day = (n: number) => NOW - n * 86_400_000

  test('null keeps every event; a window keeps only recent cooks', () => {
    const events = [event(1, day(5)), event(2, day(40)), event(3, day(120))]
    expect(filterHistoryEvents(events, null, NOW)).toHaveLength(3)
    expect(filterHistoryEvents(events, 90, NOW)).toHaveLength(2)
    expect(filterHistoryEvents(events, 30, NOW)).toHaveLength(1)
    expect(filterHistoryEvents(events, 30, NOW)[0].variantId).toBe(1)
  })

  test('the cutoff is inclusive of a cook exactly N days old', () => {
    expect(filterHistoryEvents([event(1, day(30))], 30, NOW)).toHaveLength(1)
    expect(filterHistoryEvents([event(1, day(31))], 30, NOW)).toHaveLength(0)
  })

  test('an empty window is empty — never a fake group', () => {
    expect(filterHistoryEvents([], 30, NOW)).toEqual([])
  })
})

describe('summarizeHistory (the DATA numbers in the head)', () => {
  test('counts events, distinct dishes and the most recent cook', () => {
    expect(summarizeHistory([event(1, 30), event(1, 10), event(2, 20)])).toEqual({
      total: 3,
      dishes: 2,
      lastAt: 30,
    })
  })

  test('an empty log summarizes to zeroes, not nulls beyond lastAt', () => {
    expect(summarizeHistory([])).toEqual({ total: 0, dishes: 0, lastAt: null })
  })
})

describe('cookedToday (the detail pill guard, ADR-0083 addendum)', () => {
  // Local noon anchors both sides on the same local day regardless of the
  // runner's timezone; yesterday is 24h back (crosses a midnight once).
  const NOON = new Date(); NOON.setHours(12, 0, 0, 0)
  const today = NOON.getTime()
  const yesterday = today - 24 * 60 * 60 * 1000

  test('a cook earlier TODAY counts; yesterday does not', () => {
    expect(cookedToday([today - 3_600_000], today)).toBe(true)
    expect(cookedToday([yesterday], today)).toBe(false)
  })

  test('an empty log never counts', () => {
    expect(cookedToday([], today)).toBe(false)
  })
})

describe('replanEntries ("cook that week again", ADR-0085)', () => {
  const known = new Set([1, 2, 3])

  test('dedupes, drops catalog-missing dishes, orders most-recent-cook first', () => {
    // Cooked out of order on purpose: the newest cook wins the head.
    const events = [
      event(1, 10, 'p1', 1),
      event(3, 30, 'p1', 1),
      event(1, 20, 'p1', 1), // dup — cooked twice this week
      event(9, 40, 'p1', 1), // left the catalog
      event(2, 25, 'p1', 1),
    ]
    expect(replanEntries(events, known, 4)).toEqual([
      { variantId: 3, servings: 4 }, // newest cook (30)
      { variantId: 2, servings: 4 }, // (25)
      { variantId: 1, servings: 4 }, // most recent cook of 1 is 20
    ])
  })

  test('empty group or an all-gone catalog yields nothing', () => {
    expect(replanEntries([], known, 4)).toEqual([])
    expect(replanEntries([event(9, 10, 'p1', 1)], known, 4)).toEqual([])
    expect(replanEntries([event(1, 10, 'p1', 1)], new Set<number>(), 4)).toEqual([])
  })

  test('carries the caller\'s servings verbatim (ADR-0037 remembered default)', () => {
    expect(replanEntries([event(2, 10, 'p1', 1)], known, 2)).toEqual([
      { variantId: 2, servings: 2 },
    ])
  })

  test('ties on cookedAt order deterministically (same rule as the history merge)', () => {
    const a = event(1, 50, 'p1', 1)
    const b = event(2, 50, 'p1', 1)
    const forward = replanEntries([a, b], known, 4)
    const backward = replanEntries([b, a], known, 4)
    expect(forward).toEqual(backward)
  })
})
