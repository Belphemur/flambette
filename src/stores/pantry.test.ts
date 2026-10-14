import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { normalizePantryRows, usePantryStore } from './pantry'

/**
 * Pantry store hardening (qodo round 2): data that did not go through
 * `add()` — backup import (`replaceAll`) and the persisted localStorage
 * blob (afterHydrate) — must never break the store's invariants
 * (canonical nameKey identity, unique keys, cap) nor throw while the
 * Recipes tab reads it.
 */

beforeEach(() => {
  setActivePinia(createPinia())
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
})

describe('normalizePantryRows', () => {
  test('re-derives the canonical key from the name (never trusts nameKey)', () => {
    const rows = normalizePantryRows([{ name: 'Yellow Potatoes', nameKey: 'bogus-key' }])
    expect(rows).toEqual([{ name: 'Yellow Potatoes', nameKey: 'yellow potato' }])
  })

  test('drops null entries, non-objects and empty names', () => {
    const rows = normalizePantryRows([null, 'x', {}, { name: '   ', nameKey: 'x' }, { name: 'Tomato', nameKey: 'tomato' }])
    expect(rows).toEqual([{ name: 'Tomato', nameKey: 'tomato' }])
  })

  test('a non-array yields the empty list (damaged blob never throws)', () => {
    expect(normalizePantryRows('garbage')).toEqual([])
    expect(normalizePantryRows(null)).toEqual([])
    expect(normalizePantryRows({ list: [] })).toEqual([])
  })

  test('duplicates dedupe first-wins by the canonical key', () => {
    const rows = normalizePantryRows([
      { name: 'Tomato', nameKey: 'tomato' },
      { name: 'tomatoes', nameKey: 'tomatoes' },
      { name: 'Garlic', nameKey: 'garlic' },
    ])
    expect(rows.map((r) => r.name)).toEqual(['Tomato', 'Garlic'])
  })

  test('trims and clamps names to 80 chars', () => {
    const rows = normalizePantryRows([{ name: '  fresh basil  ', nameKey: 'whatever' }])
    expect(rows[0]!.name).toBe('fresh basil')
    const long = normalizePantryRows([{ name: 'a'.repeat(200), nameKey: 'a'.repeat(200) }])
    expect(long[0]!.name).toBe('a'.repeat(80))
    expect(long[0]!.nameKey).toBe('a'.repeat(80))
  })
})

describe('usePantryStore hardening', () => {
  test('replaceAll normalizes imported rows (backup import path)', () => {
    const pantry = usePantryStore()
    pantry.replaceAll([
      { name: 'Garlic', nameKey: 'wrong' },
      { name: 'tomatoes', nameKey: 'tomato' },
      { name: 'Tomato', nameKey: 'tomato' },
    ] as never)
    expect(pantry.list.map((r) => `${r.name}:${r.nameKey}`)).toEqual(['Garlic:garlic', 'tomatoes:tomato'])
    expect(pantry.keys.has('tomato')).toBe(true)
  })

  test('repairHydratedRows repairs a damaged persisted list', () => {
    const pantry = usePantryStore()
    // Simulate what a damaged localStorage blob hydrates into the ref.
    ;(pantry.$state as { list: unknown }).list = [
      null,
      'garbage',
      { name: 'Olive Oil', nameKey: 'stale-key' },
      { name: 'olive oil', nameKey: 'olive oil' },
    ] as never
    pantry.repairHydratedRows()
    expect(pantry.list).toEqual([{ name: 'Olive Oil', nameKey: 'olive oil' }])
    expect(pantry.active).toBe(true)
  })

  test('repairHydratedRows resets a non-array list to empty', () => {
    const pantry = usePantryStore()
    ;(pantry.$state as { list: unknown }).list = 'corrupted' as never
    pantry.repairHydratedRows()
    expect(pantry.list).toEqual([])
    expect(pantry.active).toBe(false)
  })

  test('keys stays array-safe while reading a damaged list before repair', () => {
    const pantry = usePantryStore()
    ;(pantry.$state as { list: unknown }).list = [null, { name: 'Basil', nameKey: 'basil' }] as never
    // The defensive computed must not throw on the damaged entry.
    expect(pantry.keys.has('basil')).toBe(true)
  })
})