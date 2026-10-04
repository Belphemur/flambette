import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useGroceryStore } from './grocery'
import { usePlanStore } from './plan'
import { EXTRA_KEY_PREFIX } from '../lib/extraCheckedKeys'

/**
 * `reconcileExtras` is the store-level entry point, called at the boundaries
 * where `customItems` and `checked` arrive from OUTSIDE as separate fields:
 * a room snapshot (`room.applyRemote`), a backup archive (`backup.ts`'s
 * `checked.json` writer) and a shared plan link (`App.vue`'s
 * `importSharedPlan`). These cases pin that it heals the desync, and — just
 * as important — that it reports no change when there is nothing to heal (so
 * callers can skip a write / a republish).
 */
describe('grocery.reconcileExtras', () => {
  beforeEach(() => setActivePinia(createPinia()))

  test('removes the checked key of an extra that is no longer in the plan', () => {
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = ['kale']
    grocery.map = { [`${EXTRA_KEY_PREFIX}kale`]: true, [`${EXTRA_KEY_PREFIX}ghost`]: true }

    expect(grocery.reconcileExtras(plan.customItems)).toBe(true)
    expect(grocery.map).toEqual({ [`${EXTRA_KEY_PREFIX}kale`]: true })
  })

  test('reports no change when the key and the extras already agree', () => {
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = ['kale', 'apple']
    grocery.map = { [`${EXTRA_KEY_PREFIX}kale`]: true }

    expect(grocery.reconcileExtras(plan.customItems)).toBe(false)
    expect(grocery.map).toEqual({ [`${EXTRA_KEY_PREFIX}kale`]: true })
  })

  test('keeps recipe-derived line keys when every extra is gone', () => {
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = []
    grocery.map = { [`${EXTRA_KEY_PREFIX}ghost`]: true, '999||tomato': true }

    grocery.reconcileExtras(plan.customItems)

    // The grocery line key belongs to the PLAN's lifecycle; dropping it
    // would silently un-check an item the user already picked up.
    expect(grocery.map).toEqual({ '999||tomato': true })
  })

  test('the healed state is what re-adding the extra then reads', () => {
    // The end-to-end shape of the bug: without reconciliation, re-adding
    // "ghost" lands already-checked, so its sub-section is instantly "done"
    // and auto-collapse hides the row the user just added.
    const plan = usePlanStore()
    const grocery = useGroceryStore()

    plan.customItems = ['kale']
    grocery.map = { [`${EXTRA_KEY_PREFIX}ghost`]: true }
    grocery.reconcileExtras(plan.customItems)

    plan.customItems = [...plan.customItems, 'ghost']
    expect(grocery.isChecked(`${EXTRA_KEY_PREFIX}ghost`)).toBe(false)
  })
})
