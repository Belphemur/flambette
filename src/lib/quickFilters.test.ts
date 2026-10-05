import { describe, expect, test } from 'bun:test'
import {
  defaultQuickFilters,
  hasActiveFilters,
  matchesSource,
  mergeSharedFilters,
  migrateLegacyUiFilters,
  normalizeQuickFilters,
  proteinLabel,
  sameQuickFilters,
  sortLabel,
  sourceLabel,
  toSharedFilters,
  type QuickFilters,
} from './quickFilters'
import { USER_RECIPE_ID_BASE } from './userRecipes'

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
      source: 'new',
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

  test('source: the offered values round-trip, anything else means All', () => {
    for (const good of ['all', 'pro', 'new'] as const) {
      expect(normalizeQuickFilters({ source: good })?.source).toBe(good)
    }
    for (const bad of ['mealime', 'user', 'New', '', null, 7, true]) {
      expect(normalizeQuickFilters({ source: bad })?.source, String(bad)).toBe('all')
    }
  })

  test('the retired proOnly boolean migrates to the source facet (ADR-0052 §3)', () => {
    // A RENAME, not a reinterpretation: the old chip said "PRO recipes
    // only", so a household that had it pinned keeps exactly that grid.
    expect(normalizeQuickFilters({ proOnly: true })?.source).toBe('pro')
    expect(normalizeQuickFilters({ proOnly: false })?.source).toBe('all')
    // Nothing about the legacy key leaks into the result: the type has
    // ONE spelling, and `sameQuickFilters` compares that one.
    const migrated = normalizeQuickFilters({ proOnly: true })!
    expect('proOnly' in migrated).toBe(false)
    expect(migrated).toEqual({ ...defaultQuickFilters(), source: 'pro' })
    // An explicit `source` always wins, so a payload carrying both (a
    // peer mid-migration) is not overwritten by the legacy key.
    expect(normalizeQuickFilters({ source: 'new', proOnly: true })?.source).toBe('new')
    // A FRESH install must not be mistaken for a legacy one: it already
    // carries `source: 'all'` and no `proOnly`, so it stays at All.
    expect(normalizeQuickFilters(defaultQuickFilters())?.source).toBe('all')
  })

  test('a legacy v0.12 blob still migrates its dietFilters AND its proOnly', () => {
    // migrateLegacyUiFilters forwards the WHOLE blob, not just the
    // members it knows: a blob carrying both keys loses neither.
    const seeded = migrateLegacyUiFilters(
      JSON.stringify({ dietFilters: ['vegan'], proOnly: true, householdRoom: 'amber-falcon-lantern' }),
    )
    expect(seeded?.diets).toEqual(['vegan'])
    expect(seeded?.source).toBe('pro')
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
    // `source` is household state, so narrowing it is an active change…
    expect(hasActiveFilters({ ...defaultQuickFilters(), source: 'pro' })).toBe(true)
    expect(hasActiveFilters({ ...defaultQuickFilters(), source: 'new' })).toBe(true)
    expect(sameQuickFilters(defaultQuickFilters(), { ...defaultQuickFilters(), source: 'new' })).toBe(
      false,
    )
    // …and the default must NOT read as active, or a fresh install would
    // show a "clear filters" affordance nobody asked for.
    expect(hasActiveFilters({ ...defaultQuickFilters(), source: 'all' })).toBe(false)
  })

  test('source travels with the household half, unlike favOnly', () => {
    // ADR-0028's split: a household browsing "New" is browsing together,
    // so `source` is shared and only the favourites SWITCH stays personal.
    const local: QuickFilters = { ...defaultQuickFilters(), favOnly: true, source: 'new' }
    expect(toSharedFilters(local).source).toBe('new')
    const inbound = normalizeQuickFilters({ source: 'pro' })!
    expect(mergeSharedFilters(inbound, local).source).toBe('pro')
    expect(mergeSharedFilters(inbound, local).favOnly).toBe(true)
  })
})

describe('matchesSource (ADR-0052 §3)', () => {
  const MEALIME = { id: 17452, is_pro: false }
  const MEALIME_PRO = { id: 17453, is_pro: true }
  const OURS = { id: USER_RECIPE_ID_BASE, is_pro: false }
  const IDS = new Set([USER_RECIPE_ID_BASE])

  test('all admits both catalogs', () => {
    expect(matchesSource('all', MEALIME, IDS)).toBe(true)
    expect(matchesSource('all', MEALIME_PRO, IDS)).toBe(true)
    expect(matchesSource('all', OURS, IDS)).toBe(true)
  })

  test('pro is exactly the old proOnly: meta.is_pro', () => {
    expect(matchesSource('pro', MEALIME_PRO, IDS)).toBe(true)
    expect(matchesSource('pro', MEALIME, IDS)).toBe(false)
    // A user recipe is never PRO, so the two buckets cannot overlap. That
    // is why this became a third value instead of a second boolean.
    expect(matchesSource('pro', OURS, IDS)).toBe(false)
  })

  test('new is the artifact id set, and it is permanent', () => {
    expect(matchesSource('new', OURS, IDS)).toBe(true)
    expect(matchesSource('new', MEALIME, IDS)).toBe(false)
    // A recipe added years ago is still authored by the household. The
    // 30-day expiry lives in userRecipes.showNewBadge and drives the
    // BADGE; a filter that emptied itself would be a bug (locked L1).
    expect(matchesSource('new', OURS, IDS)).toBe(true)
  })

  test('an empty id set (a build with no user recipes) still filters sanely', () => {
    expect(matchesSource('new', OURS, new Set())).toBe(false)
    expect(matchesSource('pro', MEALIME_PRO, new Set())).toBe(true)
    expect(matchesSource('all', OURS, new Set())).toBe(true)
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
    expect(sourceLabel('all')).toBe('All sources')
    expect(sourceLabel('pro')).toBe('PRO')
    expect(sourceLabel('new')).toBe('New')
  })
})
