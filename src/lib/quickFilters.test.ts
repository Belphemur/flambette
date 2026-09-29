import { describe, expect, test } from 'bun:test'
import {
  defaultQuickFilters,
  hasActiveFilters,
  normalizeQuickFilters,
  proteinLabel,
  sameQuickFilters,
  sortLabel,
  type QuickFilters,
} from './quickFilters'

describe('normalizeQuickFilters', () => {
  test('a non-object payload means "no filters" (older peer sends none)', () => {
    expect(normalizeQuickFilters(undefined)).toBeNull()
    expect(normalizeQuickFilters(null)).toBeNull()
    expect(normalizeQuickFilters('nope')).toBeNull()
    expect(normalizeQuickFilters([1, 2])).toBeNull()
  })

  test('a complete payload round-trips', () => {
    const f: QuickFilters = {
      diets: ['vegan', 'no-pork'],
      protein: 'fish',
      maxTime: 30,
      sortBy: 'time',
      favOnly: true,
      proOnly: true,
    }
    expect(normalizeQuickFilters(f)).toEqual(f)
  })

  test('unknown diet ids are dropped, known ones kept, duplicates collapsed', () => {
    expect(
      normalizeQuickFilters({ diets: ['vegan', 'keto', 'vegan', 7, null] })?.diets,
    ).toEqual(['vegan'])
  })

  test('a partial payload keeps its members and defaults the rest', () => {
    const f = normalizeQuickFilters({ diets: ['vegetarian'] })
    expect(f).toEqual({ ...defaultQuickFilters(), diets: ['vegetarian'] })
  })

  test('out-of-range enum members fall back to the default, not to junk', () => {
    const f = normalizeQuickFilters({
      protein: 'kangaroo',
      sortBy: 'sideways',
      maxTime: Number.NaN,
      favOnly: 'yes',
    })
    expect(f).toEqual(defaultQuickFilters())
    expect(normalizeQuickFilters({ maxTime: 45 })?.maxTime).toBe(45)
  })
})

describe('sameQuickFilters / hasActiveFilters', () => {
  test('diets compare by set contents and order', () => {
    const a: QuickFilters = { ...defaultQuickFilters(), diets: ['vegan', 'no-pork'] }
    const b: QuickFilters = { ...defaultQuickFilters(), diets: ['no-pork', 'vegan'] }
    expect(sameQuickFilters(a, a)).toBe(true)
    expect(sameQuickFilters(a, b)).toBe(false)
    expect(sameQuickFilters(a, { ...a, diets: ['vegan'] })).toBe(false)
  })

  test('sort order alone counts as an active (synced) change', () => {
    expect(hasActiveFilters(defaultQuickFilters())).toBe(false)
    expect(hasActiveFilters({ ...defaultQuickFilters(), sortBy: 'latest' })).toBe(false)
    expect(hasActiveFilters({ ...defaultQuickFilters(), favOnly: true })).toBe(true)
    expect(hasActiveFilters({ ...defaultQuickFilters(), protein: 'meat' })).toBe(true)
    expect(hasActiveFilters({ ...defaultQuickFilters(), maxTime: 20 })).toBe(true)
    expect(hasActiveFilters({ ...defaultQuickFilters(), diets: ['vegan'] })).toBe(true)
  })
})

describe('labels', () => {
  test('every sort mode and protein has a label', () => {
    expect(sortLabel('rating')).toBe('Top rated')
    expect(sortLabel('calories')).toBe('Fewest calories')
    expect(proteinLabel('')).toBe('Any protein')
    expect(proteinLabel('fish')).toBe('Fish')
  })
})
