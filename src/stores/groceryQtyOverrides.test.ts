import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { normalizeQtyOverrides, useQtyOverridesStore } from './groceryQtyOverrides'

/**
 * The quantity-override store hardening (ADR-0100): data that did not go
 * through `set()` — backup import, the room payload (`replaceAll`), and
 * the persisted localStorage blob (afterHydrate → `repairHydratedMap`)
 * — must never break the store's invariants (non-empty identity keys,
 * clamped non-empty amounts, cap) nor throw while the grocery views read
 * it.
 */

beforeEach(() => {
  setActivePinia(createPinia())
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
})

describe('normalizeQtyOverrides', () => {
  test('drops non-entries: non-map values, empty keys, empty/non-string amounts', () => {
    expect(normalizeQtyOverrides('garbage')).toEqual({})
    expect(normalizeQtyOverrides(null)).toEqual({})
    expect(normalizeQtyOverrides([['k', 'v']])).toEqual({})
    expect(
      normalizeQtyOverrides({ '': '1 cup', ok: '2 cups', bad: '', alsoBad: 3, nul: null }),
    ).toEqual({ ok: '2 cups' })
  })

  test('trims keys and clamps amounts to 80 chars', () => {
    expect(normalizeQtyOverrides({ ' egg || ml ': '  500 ml  ' })).toEqual({
      'egg || ml': '500 ml',
    })
    const long = normalizeQtyOverrides({ a: 'x'.repeat(200) })
    expect(long.a).toBe('x'.repeat(80))
  })

  test('inbound numeric values carry the editor\'s shared clamp (round 9)', () => {
    // A buggy peer or hand-edited backup can render past the editor's
    // own range NO MORE than the editor's typed path can: parseable
    // values clamp floor/cap through the SAME grammar, prose stays verbatim.
    expect(
      normalizeQtyOverrides({ hi: '999999 cups', lo: '0 cups', keep: 'a pinch' }),
    ).toEqual({
      hi: '9999 cups',
      lo: '¼ cups',
      keep: 'a pinch',
    })
  })

  test('the cap keeps the map bounded at 500 entries', () => {
    const raw: Record<string, string> = {}
    for (let i = 0; i < 600; i++) raw[`identity-${i}`] = `${i} cups`
    const out = normalizeQtyOverrides(raw)
    expect(Object.keys(out).length).toBe(500)
  })
})

describe('useQtyOverridesStore', () => {
  test('set stores one override per line identity and skips no-change writes', () => {
    const store = useQtyOverridesStore()
    expect(store.set('egg||ml', '500 ml')).toBe(true)
    expect(store.map).toEqual({ 'egg||ml': '500 ml' })
    // The sibling line of the SAME ingredient (different unit identity)
    // is untouched — the override is per LINE, not per ingredient.
    expect(store.set('egg||row', '4 eggs')).toBe(true)
    expect(store.map['egg||ml']).toBe('500 ml')
    // Same value again: no change, and the map identity is untouched (a
    // re-assignment would fan an identical snapshot back to the room).
    const before = store.map
    expect(store.set('egg||ml', '500 ml')).toBe(false)
    expect(store.map).toBe(before)
    // Refusals: identity-less, amount-less.
    expect(store.set('', '1 cup')).toBe(false)
    expect(store.set('egg||ml', '   ')).toBe(false)
  })

  test('clear drops exactly one identity (the Reset path)', () => {
    const store = useQtyOverridesStore()
    store.set('egg||ml', '500 ml')
    store.set('egg||row', '4 eggs')
    store.clear('egg||ml')
    expect(store.map).toEqual({ 'egg||row': '4 eggs' })
    // Clearing an unknown key is a no-op: the map stays untouched (no
    // re-assignment, no push churn).
    store.clear('garlic||cups')
    expect(store.map).toEqual({ 'egg||row': '4 eggs' })
  })

  test('the override rides the LINE: a meal removed while the line persists keeps it (ADR-0100)', () => {
    // Line composition can RE-SPELL the rendered key while the identity
    // is stable — two contributors ("2 cups" + "1 cup" → "3 cups") is the
    // same `egg||cup` identity the override was written against.
    const store = useQtyOverridesStore()
    store.set('soy sauce||tbsp', '4 tbsp')
    const reRenderedKeep = store.sweep(new Set(['soy sauce||tbsp']))
    expect(reRenderedKeep).toBe(false)
    expect(store.map['soy sauce||tbsp']).toBe('4 tbsp')
    // The ingredient leaves the grocery list entirely: the override dies
    // with its line — the map never outlives the line (ADR-0100).
    expect(store.sweep(new Set(['milk||ml']))).toBe(true)
    expect(store.map).toEqual({})
  })

  test('sweep keeps overrides on lines hidden by cleared claims (inert, not orphaned)', () => {
    // A cleared claim HIDES a line from the render, but the line still
    // "exists" — its identity stays in the retention universe
    // (aggregated ignoring the cleared filter), so the sweep keeps the
    // override for the day the claim lifts.
    const store = useQtyOverridesStore()
    store.set('peach||row', '3 peaches')
    expect(store.sweep(new Set(['peach||row']))).toBe(false)
    expect(store.count).toBe(1)
  })

  test('sweep on an empty store is always a no-op (no push churn)', () => {
    const store = useQtyOverridesStore()
    expect(store.sweep(new Set())).toBe(false)
    store.set('egg||ml', '500 ml')
    expect(store.sweep(new Set(['egg||ml']))).toBe(false)
  })

  test('replaceAll normalizes an inbound payload (room snapshot path) wholesale', () => {
    const store = useQtyOverridesStore()
    store.set('egg||ml', '500 ml')
    // An older-shaped payload wins whole (LWW), never merges its garbage
    // into the held map: empty keys, non-strings and empty strings drop.
    store.replaceAll({ 'milk||ml': ' 1 L ', junk: '', zero: 0 })
    expect(store.map).toEqual({ 'milk||ml': '1 L' })
    expect(store.overrideFor('egg||ml')).toBeUndefined()
    // And an ALL-CLEAN replace replaces: the store is exactly the payload.
    store.replaceAll({ 'peach||row': '3 peaches' })
    expect(store.map).toEqual({ 'peach||row': '3 peaches' })
  })

  test('repairHydratedMap repairs a damaged persisted blob through the funnel', () => {
    const store = useQtyOverridesStore()
    ;(store as unknown as { map: Record<string, unknown> }).map = {
      'egg||ml': '  500 ml  ',
      empty: '',
      bad: 3,
    }
    store.repairHydratedMap()
    expect(store.map).toEqual({ 'egg||ml': '500 ml' })
  })
})
