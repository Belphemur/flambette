import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { usePlanStore } from './plan'
import type { VariantMeta } from '../lib/types'

/**
 * ADR-0034 — the plan's identity, the provenance stamped on a cook event,
 * and the undo that puts both back. The rules under test are the ones a
 * view cannot express: a plan identity is minted on the empty → non-empty
 * transition and dies with the plan; an unplanned cook gets its OWN
 * one-recipe plan identity that is never written into the store; and the
 * undo restores the exact prior state rather than "roughly the plan".
 */

function meta(id: number, servingCount = 6): VariantMeta {
  return { id, serving_count: servingCount } as VariantMeta
}

describe('plan identity (ADR-0034)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('the first meal starts the plan identity; a second meal keeps it', () => {
    const plan = usePlanStore()
    expect(plan.planId).toBe('')
    plan.addToPlan(meta(1), 4)
    const { planId, planCreatedAt } = plan.ensurePlanIdentity()
    expect(planId).not.toBe('')
    expect(planCreatedAt).toBeGreaterThan(0)

    // Same plan → same identity, and the creation time is NOT re-stamped.
    plan.addToPlan(meta(2), 4)
    expect(plan.ensurePlanIdentity()).toEqual({ planId, planCreatedAt })
  })

  test('emptying the plan ends that plan; the next meal starts a NEW one', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1))
    const first = plan.planId
    plan.removeFromPlan(1)
    expect(plan.planId).toBe('')
    expect(plan.planCreatedAt).toBe(0)

    plan.addToPlan(meta(3))
    expect(plan.planId).not.toBe(first)
  })

  test('clearPlan ends the plan identity too', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1))
    plan.clearPlan()
    expect(plan.planId).toBe('')
  })

  test('replacePlan is a NEW plan: it never keeps the previous identity', () => {
    // Auto-Plan in replace mode, a `?p=` share import and an inbound room
    // snapshot all go through replacePlan. Keeping the old id would file
    // the next cook under a plan this device no longer has, and would
    // publish that stale id to every peer.
    const plan = usePlanStore()
    plan.addToPlan(meta(1))
    const before = plan.planId
    plan.replacePlan([{ variantId: 2, servings: 3 }], ['milk'])
    expect(plan.planId).not.toBe(before)
    expect(plan.planCreatedAt).toBeGreaterThan(0)

    // Replacing with an empty plan ends the identity outright.
    plan.replacePlan([], [])
    expect(plan.planId).toBe('')
    expect(plan.planCreatedAt).toBe(0)
  })
})

describe('cook provenance (ADR-0034)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('cooking a PLANNED meal stamps the current plan identity', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    const identity = plan.ensurePlanIdentity()
    const event = plan.markCooked(1)
    expect(event.planId).toBe(identity.planId)
    expect(event.planCreatedAt).toBe(identity.planCreatedAt)
    expect(plan.plan).toHaveLength(0)
  })

  test('cooking an UNPLANNED meal mints an ad-hoc one-recipe plan', () => {
    const plan = usePlanStore()
    const event = plan.markCooked(9)
    expect(event.planId).toBeTruthy()
    expect(event.planCreatedAt).toBeGreaterThan(0)
    // The ad-hoc identity is NOT adopted as the household's plan: an
    // ad-hoc cook must neither become nor overwrite the real plan.
    expect(plan.planId).toBe('')
  })

  test('one cook session = one ad-hoc plan: the context is the caller’s', () => {
    const plan = usePlanStore()
    const session = plan.cookPlanIdentity(9)
    const mid = plan.markCooked(9, session)
    const done = plan.markCooked(9, session)
    expect(mid.planId).toBe(session.planId)
    expect(done.planId).toBe(session.planId)
    // A LATER ad-hoc cook is a different plan, not a continuation.
    expect(plan.cookPlanIdentity(9).planId).not.toBe(session.planId)
  })

  test('ad-hoc plan ids never collide with a persisted plan identity', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1))
    const real = plan.cookPlanIdentity(1) // planned: the store's own plan
    const adHoc = plan.cookPlanIdentity(2)
    expect(adHoc.planId).not.toBe(real.planId)
    expect(plan.planId).toBe(real.planId)
  })

  test('merge and replace carry the provenance through', () => {
    const plan = usePlanStore()
    plan.markCooked(5)
    const mine = plan.cookedHistory[0]
    expect(plan.mergeCookedHistory([
      { variantId: 6, cookedAt: 1, id: 'peer-1', planId: 'plan-p', planCreatedAt: 0.5 },
    ])).toBe(true)
    expect(plan.cookedHistory.find((r) => r.id === 'peer-1')).toEqual({
      variantId: 6,
      cookedAt: 1,
      id: 'peer-1',
      planId: 'plan-p',
      planCreatedAt: 0.5,
    })

    plan.replaceCookedHistory([
      { variantId: 7, cookedAt: 2, id: 'peer-2', planId: 'plan-q', planCreatedAt: 1 },
    ])
    expect(plan.cookedHistory[0]).toEqual({
      variantId: 7,
      cookedAt: 2,
      id: 'peer-2',
      planId: 'plan-q',
      planCreatedAt: 1,
    })
    expect(mine.planId).toBeTruthy()
  })
})

describe('undoing a cook (ADR-0034)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('restores the plan entry, its servings, the cleared row and the identity', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    const identity = plan.ensurePlanIdentity()
    plan.clearIngredientsForCurrentMeals({ 1: ['flour', 'salt'] })
    const event = plan.markCooked(1)
    expect(plan.plan).toHaveLength(0)
    expect(plan.clearedIngredients[1]).toBeUndefined()

    plan.undoMarkCooked(event, { entry: { variantId: 1, servings: 4 }, cleared: ['flour', 'salt'] })
    expect(plan.plan).toEqual([{ variantId: 1, servings: 4 }])
    expect(plan.clearedIngredients[1]).toEqual(['flour', 'salt'])
    // The plan is the SAME plan it was before the cook: a mid-cook undo
    // must not leave the household looking at a different plan id.
    expect(plan.planId).toBe(identity.planId)
    expect(plan.cookedHistory).toHaveLength(0)
  })

  test('an ad-hoc cook undoes to nothing but its own event', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(2), 4)
    const event = plan.markCooked(9)
    expect(plan.plan).toEqual([{ variantId: 2, servings: 4 }])

    plan.undoMarkCooked(event, { entry: null, cleared: null })
    expect(plan.cookedHistory).toHaveLength(0)
    // The unrelated planned meal — and its plan — are untouched.
    expect(plan.plan).toEqual([{ variantId: 2, servings: 4 }])
    expect(plan.planId).not.toBe('')
  })

  test('undo does not relabel a plan that has since started anew', () => {
    const plan = usePlanStore()
    plan.addToPlan(meta(1), 4)
    const event = plan.markCooked(1)
    // The cook emptied the plan; a new meal has since started ANOTHER one.
    plan.addToPlan(meta(2), 2)
    const current = plan.planId

    plan.undoMarkCooked(event, { entry: { variantId: 1, servings: 4 }, cleared: null })
    // The meal is back, but the identity stays the newer plan's: the older
    // cook's plan is genuinely over, and relabelling it would file an
    // unrelated batch under a plan the user already finished.
    expect(plan.plan.map((e) => e.variantId)).toEqual([2, 1])
    expect(plan.planId).toBe(current)
  })

  test('unmarkCooked is a no-op for an event we do not hold', () => {
    const plan = usePlanStore()
    expect(plan.unmarkCooked({ variantId: 42, cookedAt: 1, id: 'nope' })).toBe(false)
  })
})
