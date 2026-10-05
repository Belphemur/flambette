import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useGroceryStore } from './grocery'
import { usePlanStore } from './plan'
import { EXTRA_KEY_PREFIX } from '../lib/extraCheckedKeys'

/**
 * `reconcileExtras` is the store-level entry point, called at the boundaries
 * where `customItems` and `checked` arrive from OUTSIDE as separate fields:
 * a room snapshot (`room.applyRemote`) and a backup archive (`backup.ts`'s
 * `checked.json` writer). These cases pin that it heals the desync, and —
 * just as important — that it reports no change when there is nothing to
 * heal (so callers can skip a write / a republish).
 *
 * (ADR-0051 retired one-shot `?p=` plan links, which had been a THIRD
 * ingress point. It also removed one of the ways this desync could arise:
 * a share link replaced `customItems` while carrying no checked state.)
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

  test('migrateLegacyKeys re-keys a PERSISTED pre-ADR-0050 map on reload', () => {
    // The data-loss case kody-ai flagged (high): the ingress points only cover
    // state arriving from OUTSIDE, so a plain reload after the prefix change
    // hydrated `custom||<name>` keys while the renderers read
    // `extra::<name>` — every already-checked extra would render UNCHECKED.
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = ['kale', 'apple']
    // What localStorage held from the older build.
    grocery.map = { 'custom||kale': true, 'custom||apple': true, '999||tomato': true }

    grocery.migrateLegacyKeys()

    expect(grocery.isChecked('extra::kale')).toBe(true)
    expect(grocery.isChecked('extra::apple')).toBe(true)
    expect(grocery.map['999||tomato']).toBe(true)
    // No legacy key survives.
    expect(Object.keys(grocery.map).some((k) => k.startsWith('custom||'))).toBe(false)
  })

  test('migrateLegacyKeys is idempotent and a no-op on a current map', () => {
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = ['kale']
    grocery.map = { 'extra::kale': true }

    grocery.migrateLegacyKeys()
    expect(grocery.map).toEqual({ 'extra::kale': true })
  })

  test('migrateLegacyKeys leaves an ambiguous legacy key (possible line key) alone', () => {
    const plan = usePlanStore()
    const grocery = useGroceryStore()
    plan.customItems = ['kale']
    // Matches no live extra, so it is far more likely a line key for an
    // ingredient named "custom" than an extra nobody has.
    grocery.map = { 'custom||6 medium carrots': true }

    grocery.migrateLegacyKeys()

    expect(grocery.map).toEqual({ 'custom||6 medium carrots': true })
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
