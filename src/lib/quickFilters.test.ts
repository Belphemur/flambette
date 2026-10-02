import { describe, expect, test } from 'bun:test'
import {
  defaultQuickFilters,
  hasActiveFilters,
  mergeSharedFilters,
  migrateLegacyUiFilters,
  normalizeQuickFilters,
  proteinLabel,
  sameQuickFilters,
  sortLabel,
  toSharedFilters,
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
      mealType: -2,
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

  test('meal type: an offered id round-trips, anything else means Any (ADR-0043)', () => {
    // The five occasions the dropdown offers are the only accepted ids.
    expect(normalizeQuickFilters({ mealType: -2 })?.mealType).toBe(-2)
    // `cpg` (-6) is COUNTED for partition parity but is not a meal
    // anyone plans around, so the dropdown never offers it.
    expect(normalizeQuickFilters({ mealType: -6 })?.mealType).toBeNull()
    // A stale peer, a truncated payload and a variant id (always positive)
    // all land on Any rather than on a facet that would blank the grid.
    expect(normalizeQuickFilters({ mealType: 17 })?.mealType).toBeNull()
    expect(normalizeQuickFilters({ mealType: 'dinner' })?.mealType).toBeNull()
    expect(normalizeQuickFilters({})?.mealType).toBeNull()
  })

  test('a meal type counts as an active filter and as a room-visible change', () => {
    const base = defaultQuickFilters()
    expect(hasActiveFilters(base)).toBe(false)
    const dessert = { ...base, mealType: -2 } as QuickFilters
    expect(hasActiveFilters(dessert)).toBe(true)
    expect(sameQuickFilters(base, dessert)).toBe(false)
    // …and it is household state, so it travels with the rest.
    expect(toSharedFilters(dessert).mealType).toBe(-2)
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

  test('maxTime is limited to the values the control offers', () => {
    // A hostile or hand-edited payload with `maxTime: -1` would make the
    // facet reject EVERY recipe, with no select option to reset it.
    for (const bad of [-1, 0, 12.5, 999, '30', Number.POSITIVE_INFINITY]) {
      expect(normalizeQuickFilters({ maxTime: bad })?.maxTime, String(bad)).toBeNull()
    }
    for (const good of [20, 30, 45]) {
      expect(normalizeQuickFilters({ maxTime: good })?.maxTime).toBe(good)
    }
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

describe('the personal half never crosses the wire (ADR-0028)', () => {
  test('toSharedFilters drops favOnly, mergeSharedFilters keeps it local', () => {
    // Favourites are a PERSONAL set, so a peer's "favourites only" switch
    // would blank a device that has no favourites (qodo).
    const local: QuickFilters = { ...defaultQuickFilters(), favOnly: true, diets: ['vegan'] }
    const shared = toSharedFilters(local)
    expect('favOnly' in shared).toBe(false)

    const inbound = normalizeQuickFilters({ diets: ['vegan'], favOnly: true })!
    const merged = mergeSharedFilters(inbound, local)
    expect(merged.favOnly).toBe(true) // the DEVICE decides, not the wire
    expect(merged.diets).toEqual(['vegan'])
  })
})

describe('migrateLegacyUiFilters (a v0.12 localStorage blob)', () => {
  test('a blob with only dietFilters is seeded into the unified object', () => {
    const seeded = migrateLegacyUiFilters(JSON.stringify({ dietFilters: ['vegan', 'bogus'] }))
    expect(seeded?.diets).toEqual(['vegan'])
    expect(seeded?.sortBy).toBe('rating')
  })

  test('an already-migrated blob is left alone', () => {
    expect(migrateLegacyUiFilters(JSON.stringify({ quickFilters: defaultQuickFilters() }))).toBeNull()
  })

  test('junk input yields null rather than a guess', () => {
    expect(migrateLegacyUiFilters(null)).toBeNull()
    expect(migrateLegacyUiFilters('not json')).toBeNull()
    expect(migrateLegacyUiFilters('[]')).toBeNull()
    expect(migrateLegacyUiFilters(JSON.stringify({ dietFilters: 'vegan' }))).toBeNull()
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
