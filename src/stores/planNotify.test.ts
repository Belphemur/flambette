import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { onPlanStarted, usePlanStore } from './plan'
import type { VariantMeta } from '../lib/types'

/**
 * ADR-0102 plan-started trigger: the plan store is the ONE writer of plan
 * mutations, so the 0 → ≥1 transition fires the registered listeners at
 * the mutation sites — `addToPlan` and a non-exempt `replacePlan` — while
 * the explicitly-exempt call shapes (an inbound room snapshot, a backup
 * restore, an undo, and the cook path's own `undoMarkCooked`) stay
 * silent. No watcher infers cause; these specs pin that.
 */

function meta(id: number, servingCount = 6): VariantMeta {
  return { id, serving_count: servingCount } as VariantMeta
}

describe('plan-started trigger (ADR-0102)', () => {
  let fired: number
  let off: (() => void) | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    fired = 0
    off?.()
    off = onPlanStarted(() => {
      fired++
    })
  })

  test('the FIRST add on an empty plan fires; later adds do not', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    expect(fired).toBe(1)
    plan.addToPlan(meta(2), 4)
    expect(fired).toBe(1)
    // Re-scaling an existing entry is not a start either.
    plan.addToPlan(meta(2), 6)
    expect(fired).toBe(1)
  })

  test('the cook path is exempt: undoMarkCooked restoring an entry never fires', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    expect(fired).toBe(1)
    const event = plan.markCooked(1)
    // The undo restores the plan entry — possibly onto an EMPTY plan —
    // and must not read as a plan start.
    plan.undoMarkCooked(event, {
      entry: { variantId: 1, servings: 4 },
      cleared: null,
    })
    expect(fired).toBe(1)
  })

  test('an inbound room snapshot (notifyExempt) does not fire', () => {
    const plan = usePlanStore()
    plan.replacePlan(
      [
        { variantId: 1, servings: 4 },
        { variantId: 2, servings: 4 },
      ],
      [],
      undefined,
      { notifyExempt: true },
    )
    expect(fired).toBe(0)
  })

  test('a backup restore (notifyExempt) does not fire', () => {
    const plan = usePlanStore()
    plan.replacePlan([{ variantId: 7, servings: 2 }], [], undefined, { notifyExempt: true })
    expect(fired).toBe(0)
  })

  test('a genuine Auto-Plan apply (non-exempt replacePlan onto an empty plan) fires', () => {
    const plan = usePlanStore()
    plan.replacePlan([{ variantId: 3, servings: 6 }], [])
    expect(fired).toBe(1)
  })

  test('a replacePlan that does NOT transition 0 → ≥1 does not fire', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    expect(fired).toBe(1)
    // Replace mode over a NON-empty plan: already started, no news.
    plan.replacePlan([{ variantId: 9, servings: 6 }], [])
    expect(fired).toBe(1)
    // Replacing with an EMPTY plan is a plan ending, not a start.
    plan.replacePlan([], [])
    expect(fired).toBe(1)
  })

  test('the unsubscribe stops the listener', () => {
    const plan = usePlanStore()
    off?.()
    plan.addToPlan(meta(1), 4)
    expect(fired).toBe(0)
  })
})
