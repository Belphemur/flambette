import { describe, expect, test } from 'bun:test'
import { aggregateHistory, cookCount, cookEventsFor, groupHistoryByPlan } from './history'
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
