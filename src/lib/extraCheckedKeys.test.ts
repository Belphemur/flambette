import { describe, expect, test } from 'bun:test'
import {
  EXTRA_KEY_PREFIX,
  extraCheckedKey,
  reconcileCheckedExtras,
} from './extraCheckedKeys'

/**
 * The `custom||` key is DERIVED from an extra's name, so the key and the
 * extra it describes are two facts that must agree — and nothing else
 * enforces it. `plan.customItems` and the checked map travel as SEPARATE
 * fields in room snapshots, backup archives and share links, so any peer at
 * any app version can hand us a key with no matching extra.
 *
 * When that happens the residue is invisible but harmful: the key reads as
 * "already done", so re-adding that name lands in a sub-section the
 * done-map immediately calls COMPLETE, and ADR-0050's uniform auto-collapse
 * hides the row the user just added. These cases pin the reconciler that
 * removes it.
 */
describe('extraCheckedKey', () => {
  test('is the lowercased custom|| form, so two casings of a name collide', () => {
    expect(extraCheckedKey('Banana')).toBe('custom||banana')
    expect(extraCheckedKey('banana')).toBe('custom||banana')
  })
})

describe('reconcileCheckedExtras', () => {
  test('drops a key whose extra is gone', () => {
    const { map, changed } = reconcileCheckedExtras({ 'custom||ghost': true }, ['kale'])
    expect(map).toEqual({})
    expect(changed).toBe(true)
  })

  test('keeps a key whose extra is still present', () => {
    const { map, changed } = reconcileCheckedExtras({ 'custom||kale': true }, ['kale'])
    expect(map).toEqual({ 'custom||kale': true })
    expect(changed).toBe(false)
  })

  test('matches the extra case-insensitively (the key is lowercased on both sides)', () => {
    const { map, changed } = reconcileCheckedExtras({ 'custom||kale': true }, ['KALE'])
    expect(map).toEqual({ 'custom||kale': true })
    expect(changed).toBe(false)
  })

  test('never touches recipe-derived line keys, even when no extras exist', () => {
    // A grocery line key's lifecycle belongs to the PLAN, not the extras:
    // `checked.json` and a room snapshot both carry these, and they must
    // survive untouched or the list silently un-checks itself mid-shop.
    const checked = {
      'custom||ghost': true,
      '12345||tomato': true,
      '12345||onion': true,
    }
    const { map } = reconcileCheckedExtras(checked, [])
    expect(map).toEqual({ '12345||tomato': true, '12345||onion': true })
  })

  test('a false-valued custom key is dropped too (it is still residue)', () => {
    const { map, changed } = reconcileCheckedExtras({ 'custom||ghost': false }, [])
    expect(map).toEqual({})
    expect(changed).toBe(true)
  })

  test('is a no-op when everything agrees — returns the SAME object', () => {
    const checked = { 'custom||kale': true }
    const { map, changed } = reconcileCheckedExtras(checked, ['kale'])
    expect(changed).toBe(false)
    // Referential identity is what lets a caller skip a no-op store write
    // (and, in applyRemote, avoid an unnecessary republish).
    expect(map).toBe(checked as Record<string, boolean>)
  })

  test('handles an empty checked map and empty extras', () => {
    expect(reconcileCheckedExtras({}, ['kale'])).toEqual({ map: {}, changed: false })
    // `a` is NOT a custom|| key, so it survives — only custom|| residue goes.
    expect(reconcileCheckedExtras({ a: true }, [])).toEqual({
      map: { a: true },
      changed: false,
    })
  })

  test('drops only the orphans, keeping every live extra checked', () => {
    const { map } = reconcileCheckedExtras(
      { 'custom||kale': true, 'custom||apple': true, 'custom||ghost': true },
      ['kale', 'apple'],
    )
    expect(map).toEqual({ 'custom||kale': true, 'custom||apple': true })
    expect(Object.keys(map).every((k) => k.startsWith(EXTRA_KEY_PREFIX))).toBe(true)
  })
})
