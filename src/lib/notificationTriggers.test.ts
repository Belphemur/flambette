import { describe, expect, test } from 'bun:test'
import { GroceryFinishLatch } from './notificationTriggers'

/**
 * ADR-0102 grocery-finished trigger: the false→true transition of the
 * all-checked verdict, with a per-transaction latch. The machine is fed
 * the ONE derivation's counts (`useGroceryList`'s total/checked), so the
 * rules under test are exactly the transition semantics.
 */
describe('GroceryFinishLatch (ADR-0102 grocery-finished)', () => {
  test('an empty list never fires (total > 0 guard)', () => {
    const latch = new GroceryFinishLatch()
    expect(latch.observe(0, 0)).toBe(false)
    expect(latch.latched).toBe(false)
  })

  test('a partially-checked list never fires', () => {
    const latch = new GroceryFinishLatch()
    expect(latch.observe(5, 1)).toBe(false)
    expect(latch.observe(5, 4)).toBe(false)
    expect(latch.latched).toBe(false)
  })

  test('the FIRST complete check fires; the burst that follows fires nothing', () => {
    const latch = new GroceryFinishLatch()
    // A check burst: the last line's check and its neighbours land in one
    // transaction — every observation is all-checked.
    expect(latch.observe(3, 2)).toBe(false)
    expect(latch.observe(3, 3)).toBe(true)
    expect(latch.observe(3, 3)).toBe(false)
    expect(latch.observe(3, 3)).toBe(false)
  })

  test('an uncheck re-arms; a re-completion fires again (a new completion is news)', () => {
    const latch = new GroceryFinishLatch()
    expect(latch.observe(2, 2)).toBe(true)
    expect(latch.observe(2, 1)).toBe(false) // re-arms, does not fire
    expect(latch.latched).toBe(false)
    expect(latch.observe(2, 2)).toBe(true) // genuinely new completion
  })

  test('a shrunk list that stays all-checked does not re-fire (1 → only-items)', () => {
    const latch = new GroceryFinishLatch()
    expect(latch.observe(2, 2)).toBe(true)
    // A meal is cooked and its lines leave the list; the remaining list
    // is still fully checked — no transition, no notification.
    expect(latch.observe(1, 1)).toBe(false)
  })

  test('a list that empties entirely re-arms silently', () => {
    const latch = new GroceryFinishLatch()
    expect(latch.observe(2, 2)).toBe(true)
    expect(latch.observe(0, 0)).toBe(false)
    expect(latch.latched).toBe(false)
    // The next full list is a new completion.
    expect(latch.observe(1, 1)).toBe(true)
  })
})
