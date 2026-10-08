import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { STORE_SLICES } from './backup'
import { useUiStore } from '../stores/ui'
import { usePlanStore } from '../stores/plan'
import { useRatingStore } from '../stores/rating'
import { useIdentityStore } from '../stores/identity'

/** read() of the settings slice also carries the theme override, which
 *  lives in localStorage under a non-Pinia key (useDark). */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

/**
 * qodo 4128519628 — restoring an OLDER backup (written before
 * dietFilters / householdRoom / stepTimers existed) must RESET those
 * settings, not silently keep the device's current values: the restore
 * dialog claims settings are overwritten. ADR-0027 unified the Recipes-tab
 * filters into `quickFilters`; a pre-ADR-0027 `dietFilters` array is still
 * accepted and folded into the diets half.
 */
describe('settings import (ADR-0013 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  })

  const settingsSlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'settings.json')
    if (!slice) throw new Error('settings.json slice missing from STORE_SLICES')
    return slice
  }

  test('a pre-ADR-0054 backup migrates proOnly to source (backup import path)', () => {
    // The backup archive is the third inbound path for the filters (the
    // other two being the persisted ui blob and a peer's room snapshot),
    // and it goes through the same normalizeQuickFilters branch. A backup
    // written before the rename must not reset the household to All.
    settingsSlice().write({
      quickFilters: { diets: ['vegan'], sortBy: 'latest', proOnly: true },
    })
    const ui = useUiStore()
    expect(ui.quickFilters.source).toBe('pro')
    expect('proOnly' in ui.quickFilters).toBe(false)
    expect(ui.quickFilters.diets).toEqual(['vegan'])

    settingsSlice().write({ quickFilters: { proOnly: false } })
    expect(useUiStore().quickFilters.source).toBe('all')
  })

  test('a legacy backup without the new keys resets quickFilters, householdRoom and stepTimers', () => {
    // A store CURRENT value is set by calling write() with a FULL modern
    // backup first.
    settingsSlice().write({
      quickFilters: { diets: ['vegan'], protein: 'fish', maxTime: 30, sortBy: 'time', favOnly: true, proOnly: false },
      householdRoom: 'amber-falcon-lantern',
      // A pre-ADR-0041 record: no label, keyed by step-VIEW index.
      stepTimers: { 42: { 0: { remaining: 120, running: false, startedAt: null } } },
    })

    // Legacy backup: only the old fields exist.
    settingsSlice().write({ shareCookedHistory: true })

    const ui = useUiStore()
    expect(ui.quickFilters).toEqual({
      diets: [],
      protein: '',
      mealType: null,
      maxTime: null,
      sortBy: 'rating',
      favOnly: false,
      // A pre-ADR-0054 blob's `proOnly: false` maps to 'all' — the same
      // default the reset produces. Asserted so the legacy key is
      // visibly accounted for rather than silently ignored.
      source: 'all',
    })
    expect(ui.householdRoom).toBe('')
    expect(ui.stepTimers).toEqual({})
    expect(ui.shareCookedHistory).toBe(true)
  })

  /**
   * The remembered default serving size (ADR-0037) rides settings.json, so
   * a restored device starts recipes at the household's count. A backup
   * predating it has no key, which is a valid "don't touch" at the
   * VALIDATOR but must still reset on write — the dialog promises settings
   * are overwritten, which is the same rule the other modern keys follow.
   */
  test('a legacy backup without defaultServings resets it to the authored 6', () => {
    settingsSlice().write({ defaultServings: 3 })
    expect(useUiStore().defaultServings).toBe(3)

    settingsSlice().write({ shareCookedHistory: true })
    expect(useUiStore().defaultServings).toBe(6)
  })

  test('a modern backup round-trips the remembered default', () => {
    settingsSlice().write({ defaultServings: 4 })
    // Export the whole slice, then restore only the settings half under
    // test: `read()` also carries the `theme` member, whose write path
    // dispatches a StorageEvent on `window` — a browser-only call that has
    // no place in a bun-test case (and is covered by the e2e suite).
    const { defaultServings } = settingsSlice().read() as { defaultServings: number }
    expect(defaultServings).toBe(4)
    expect(settingsSlice().validate({ defaultServings })).toBeNull()

    // Change it, then restore the export: the value comes back.
    settingsSlice().write({ defaultServings: 2 })
    expect(useUiStore().defaultServings).toBe(2)
    settingsSlice().write({ defaultServings })
    expect(useUiStore().defaultServings).toBe(4)
  })

  test('an ABSENT defaultServings validates — a pre-ADR-0037 backup is restorable', () => {
    expect(settingsSlice().validate({ shareCookedHistory: true })).toBeNull()
  })

  test('a MALFORMED defaultServings is rejected, not repaired', () => {
    // Import is validation-first and atomic: a bad count must fail the
    // whole archive rather than be silently clamped into something that
    // looks like a user choice.
    for (const bad of [0, -2, 1.5, 1e9, 'four', null, NaN]) {
      expect(settingsSlice().validate({ defaultServings: bad })).toContain('defaultServings')
    }
  })

  /* ---------- unitSystem (ADR-0047) ---------- */

  test('the unit system round-trips through the settings slice', () => {
    settingsSlice().write({ unitSystem: 'imperial' })
    const { unitSystem } = settingsSlice().read() as { unitSystem: string }
    expect(unitSystem).toBe('imperial')
    expect(settingsSlice().validate({ unitSystem })).toBeNull()

    settingsSlice().write({ unitSystem: 'metric' })
    expect(useUiStore().unitSystem).toBe('metric')
    settingsSlice().write({ unitSystem: 'dual' })
    expect(useUiStore().unitSystem).toBe('dual')
    settingsSlice().write({ unitSystem })
    expect(useUiStore().unitSystem).toBe('imperial')
  })

  test('dietary restrictions round-trip through the settings slice', () => {
    // The restriction ADR: the device's active restriction ids ride the
    // backup like every other ui preference.
    settingsSlice().write({ dietaryRestrictionIds: [10, 1, 1] })
    // The write normalizes (dedupe + ascending) — the store's sole writer.
    expect(useUiStore().dietaryRestrictionIds).toEqual([1, 10])

    // EXPORT carries the ids.
    const { dietaryRestrictionIds } = settingsSlice().read() as {
      dietaryRestrictionIds: number[]
    }
    expect(dietaryRestrictionIds).toEqual([1, 10])

    // IMPORT restores them.
    settingsSlice().write({ dietaryRestrictionIds: [4, 3] })
    expect(useUiStore().dietaryRestrictionIds).toEqual([3, 4])
    settingsSlice().write({ dietaryRestrictionIds })
    expect(useUiStore().dietaryRestrictionIds).toEqual([1, 10])
  })

  test('a backup WITHOUT dietaryRestrictionIds leaves them untouched (absent ≠ wipe)', () => {
    settingsSlice().write({ dietaryRestrictionIds: [1] })
    expect(useUiStore().dietaryRestrictionIds).toEqual([1])
    // A pre-restriction backup: only the old fields exist.
    settingsSlice().write({ shareCookedHistory: true })
    expect(useUiStore().dietaryRestrictionIds).toEqual([1])
  })

  test('unknown restriction ids are DROPPED at write, not rejected', () => {
    // Ids 7/8 exist upstream but are unused and uncovered by the artifacts;
    // a stale backup carrying one must not fail the whole restore — the
    // store's sole writer normalizes it away.
    settingsSlice().write({ dietaryRestrictionIds: [1, 7, 99] })
    expect(useUiStore().dietaryRestrictionIds).toEqual([1])
  })

  test('malformed dietaryRestrictionIds reject the archive (validation-first)', () => {
    const v = settingsSlice().validate
    expect(v({ dietaryRestrictionIds: 'gluten-free' })).toContain('array of integer')
    expect(v({ dietaryRestrictionIds: [1.5] })).toContain('array of integer')
    expect(v({ dietaryRestrictionIds: ['1'] })).toContain('array of integer')
    expect(v({ dietaryRestrictionIds: [] })).toBeNull()
    expect(v({})).toBeNull()
  })

  test('an ABSENT unitSystem validates and is "don\'t touch" on write', () => {
    // A backup written before ADR-0047 carries no key: restoring it must
    // not flip a device that reads imperial back to metric.
    expect(settingsSlice().validate({ shareCookedHistory: true })).toBeNull()
    settingsSlice().write({ unitSystem: 'imperial' })
    settingsSlice().write({ householdRoom: '' })
    expect(useUiStore().unitSystem).toBe('imperial')
  })

  test('a MALFORMED unitSystem is rejected, not repaired', () => {
    for (const bad of ['', 'Metric', 'cups', null, 0, {}]) {
      expect(settingsSlice().validate({ unitSystem: bad })).toContain('unitSystem')
    }
  })

  test('a modern backup still applies its explicit values', () => {
    settingsSlice().write({
      shareCookedHistory: false,
      quickFilters: {
        diets: ['no-pork', 'no-meat'],
        protein: 'meat',
        mealType: -1,
        maxTime: 45,
        sortBy: 'calories',
        favOnly: false,
        source: 'new',
      },
      householdRoom: 'amber-falcon-lantern',
      stepTimers: { 7: { 3: { id: 3, label: 'Rice', remaining: 60, running: true, startedAt: 123 } } },
    })
    const ui = useUiStore()
    expect(ui.quickFilters).toEqual({
      diets: ['no-pork', 'no-meat'],
      protein: 'meat',
      mealType: -1,
      maxTime: 45,
      sortBy: 'calories',
      favOnly: false,
      source: 'new',
    })
    expect(ui.householdRoom).toBe('amber-falcon-lantern')
    expect(ui.stepTimers[7][3]).toEqual({
      id: 3,
      label: 'Rice',
      remaining: 60,
      running: true,
      startedAt: 123,
    })
  })

  test('a pre-ADR-0027 backup still restores its diet chips', () => {
    settingsSlice().write({ dietFilters: ['no-shellfish', 'not-a-diet'] })
    const ui = useUiStore()
    expect(ui.quickFilters.diets).toEqual(['no-shellfish'])
    expect(ui.quickFilters.sortBy).toBe('rating')
  })

  test('the export mirrors the diet filters for an older install', () => {
    useUiStore().quickFilters = { ...useUiStore().quickFilters, diets: ['vegan'] }
    const out = settingsSlice().read() as { quickFilters: { diets: string[] }; dietFilters: string[] }
    expect(out.quickFilters.diets).toEqual(['vegan'])
    expect(out.dietFilters).toEqual(['vegan'])
  })

  test('Auto-Plan v2 settings round-trip (ADR-0027 registry rule)', () => {
    // Export carries the three Auto-Plan prefs.
    const ui = useUiStore()
    ui.autoPlanRuleset = 'dessert'
    ui.autoPlanMode = 'replace'
    ui.autoPlanGeneration = 3
    const out = settingsSlice().read() as Record<string, unknown>
    expect(out.autoPlanRuleset).toBe('dessert')
    expect(out.autoPlanMode).toBe('replace')
    expect(out.autoPlanGeneration).toBe(3)

    // Import restores them.
    settingsSlice().write({
      autoPlanRuleset: 'breakfast',
      autoPlanMode: 'add',
      autoPlanGeneration: 7,
    })
    expect(ui.autoPlanRuleset).toBe('breakfast')
    expect(ui.autoPlanMode).toBe('add')
    expect(ui.autoPlanGeneration).toBe(7)

    // Invalid values are refused by validate().
    const slice = settingsSlice()
    expect(slice.validate({ autoPlanRuleset: 'brunch' })).toContain('autoPlanRuleset')
    expect(slice.validate({ autoPlanMode: 'append' })).toContain('autoPlanMode')
    expect(slice.validate({ autoPlanGeneration: -1 })).toContain('autoPlanGeneration')
    expect(slice.validate({})).toBeNull()

    // An OLD backup without the keys resets to the defaults (same rule
    // as the other settings: restore claims settings are overwritten).
    settingsSlice().write({ shareCookedHistory: true })
    expect(ui.autoPlanRuleset).toBe('dinner')
    expect(ui.autoPlanMode).toBe('add')
    expect(ui.autoPlanGeneration).toBe(0)
  })
})

/**
 * ADR-0032 — the cooked-history slice. The per-device `id` travels WITH
 * the backup: it is the event's identity across the household, so a
 * restored install must keep it or the next room merge counts the event
 * twice (restored copy keys by the pair, peers by id).
 */
describe('cooked-history slice (ADR-0032 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  })

  const historySlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'cooked-history.json')
    if (!slice) throw new Error('cooked-history.json slice missing from STORE_SLICES')
    return slice
  }

  test('export PRESERVES the event id (round-trip keeps household identity)', () => {
    usePlanStore().replaceCookedHistory([
      { variantId: 5, cookedAt: 100, id: 'dev-1' },
      { variantId: 6, cookedAt: 90 },
    ])
    expect(historySlice().read()).toEqual([
      { variantId: 5, cookedAt: 100, id: 'dev-1' },
      { variantId: 6, cookedAt: 90 },
    ])
  })

  test('import preserves ids; legacy rows without one keep the pair fallback', () => {
    const store = usePlanStore()
    historySlice().write([
      { variantId: 5, cookedAt: 100, id: 'peer-9' },
      { variantId: 6, cookedAt: 90 },
    ] as never)
    expect(store.cookedHistory).toEqual([
      { variantId: 5, cookedAt: 100, id: 'peer-9' },
      { variantId: 6, cookedAt: 90 },
    ])

    // A restored event keeps its id → a later room merge with a peer that
    // holds the same event dedupes instead of double-counting.
    store.mergeCookedHistory([{ variantId: 5, cookedAt: 100, id: 'peer-9' }])
    expect(store.cookedHistory).toHaveLength(2)
  })

  test('validate: rows must be numbers + an OPTIONAL string id', () => {
    expect(historySlice().validate([{ variantId: 5, cookedAt: 100, id: 'a' }])).toBeNull()
    expect(historySlice().validate([{ variantId: 5, cookedAt: 100 }])).toBeNull()
    expect(historySlice().validate([{ variantId: 5, cookedAt: 100, id: 3 }])).toContain(
      'optional id string',
    )
  })
})

/**
 * ADR-0034 — plan provenance on cook events, and the plan's own identity.
 * A cook's `planId` is the event's identity ACROSS THE HOUSEHOLD, exactly
 * like the per-device `id` was in ADR-0032: a restored install that dropped
 * it would file every historical cook under "earlier cooks" while its peers
 * filed them under the real plan, and the two halves of a household backup
 * would disagree. The plan identity itself round-trips in `plan.json` so a
 * restored plan's FUTURE cooks group under the plan its history already
 * names. Rows/peers predating ADR-0034 stay valid with the fields absent.
 */
describe('plan provenance on cook events (ADR-0034 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  })

  const historySlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'cooked-history.json')
    if (!slice) throw new Error('cooked-history.json slice missing from STORE_SLICES')
    return slice
  }
  const planSlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'plan.json')
    if (!slice) throw new Error('plan.json slice missing from STORE_SLICES')
    return slice
  }

  test('export PRESERVES the plan provenance, and omits it for legacy rows', () => {
    usePlanStore().replaceCookedHistory([
      { variantId: 5, cookedAt: 100, id: 'dev-1', planId: 'plan-a', planCreatedAt: 50 },
      { variantId: 6, cookedAt: 90 },
    ])
    expect(historySlice().read()).toEqual([
      { variantId: 5, cookedAt: 100, id: 'dev-1', planId: 'plan-a', planCreatedAt: 50 },
      { variantId: 6, cookedAt: 90 },
    ])
  })

  test('import preserves provenance; legacy rows stay valid without it', () => {
    const store = usePlanStore()
    historySlice().write([
      { variantId: 5, cookedAt: 100, id: 'peer-9', planId: 'plan-a', planCreatedAt: 50 },
      { variantId: 6, cookedAt: 90 },
    ] as never)
    expect(store.cookedHistory).toEqual([
      { variantId: 5, cookedAt: 100, id: 'peer-9', planId: 'plan-a', planCreatedAt: 50 },
      { variantId: 6, cookedAt: 90 },
    ])
    expect(historySlice().validate([{ variantId: 5, cookedAt: 100 }])).toBeNull()
    expect(
      historySlice().validate([
        { variantId: 5, cookedAt: 100, planId: 'plan-a', planCreatedAt: 50 },
      ]),
    ).toBeNull()
  })

  test('validate rejects HALF a provenance (a planId with no creation time)', () => {
    expect(historySlice().validate([{ variantId: 5, cookedAt: 100, planId: 'plan-a' }])).toContain(
      'plan provenance',
    )
    // The check triggers on EITHER field: a lone planCreatedAt would
    // otherwise import as a legacy row that nevertheless carries a date.
    expect(
      historySlice().validate([{ variantId: 5, cookedAt: 100, planCreatedAt: 50 }]),
    ).toContain('plan provenance')
    expect(
      historySlice().validate([
        { variantId: 5, cookedAt: 100, planId: '', planCreatedAt: 50 },
      ]),
    ).toContain('plan provenance')
    expect(
      historySlice().validate([
        { variantId: 5, cookedAt: 100, planId: 'plan-a', planCreatedAt: 'soon' },
      ]),
    ).toContain('plan provenance')
  })

  test('plan.json round-trips the plan identity; a legacy backup clears it', () => {
    const store = usePlanStore()
    store.addToPlan({ id: 5, serving_count: 4 } as never, 6)
    const exported = planSlice().read() as { planIdentity?: unknown }
    expect(exported.planIdentity).toEqual({
      planId: store.planId,
      planCreatedAt: store.planCreatedAt,
    })

    // A backup written before ADR-0034 has no planIdentity: restoring it
    // must CLEAR the identity rather than silently keeping the old plan's.
    planSlice().write({ entries: [{ variantId: 5, servings: 6 }] } as never)
    expect(store.planId).toBe('')
    expect(store.planCreatedAt).toBe(0)

    // A malformed identity is refused outright (import is validate-first).
    expect(
      planSlice().validate({ entries: [], planIdentity: { planId: 5, planCreatedAt: 1 } }),
    ).toContain('planIdentity')
    expect(
      planSlice().validate({ entries: [], planIdentity: { planId: 'p', planCreatedAt: 'now' } }),
    ).toContain('planIdentity')
  })
})

/**
 * ADR-0031 — the household ratings slice. Round-trip + validation, the
 * "opinion is never seeded from the catalog" rule, and the per-record
 * reconciliation that import inherits (newer `updatedAt` wins, so an
 * older backup cannot clobber household ratings taken since).
 */
describe('ratings slice (ADR-0031 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  })

  const ratingsSlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'ratings.json')
    if (!slice) throw new Error('ratings.json slice missing from STORE_SLICES')
    return slice
  }

  test('is registered in STORE_SLICES (export/import/validation share it)', () => {
    expect(ratingsSlice().persistKeys).toEqual(['mealime-planner:v1:ratings'])
  })

  test('seeds empty — a rating is opinion, never catalog truth', () => {
    expect(useRatingStore().ratingFor(17452)).toBe(0)
    expect(ratingsSlice().read()).toEqual([])
  })

  test('round-trips ratings through read() → write()', () => {
    const store = useRatingStore()
    store.setRating(17452, 4.5, 1_000)
    store.setRating(6389, 2, 1_000)
    const exported = ratingsSlice().read()
    expect(exported).toEqual([
      { id: 6389, rating: 2, count: 1, updatedAt: 1_000 },
      { id: 17452, rating: 4.5, count: 1, updatedAt: 1_000 },
    ])

    // A different device restores it.
    setActivePinia(createPinia())
    expect(useRatingStore().ratingFor(17452)).toBe(0)
    ratingsSlice().write(exported)
    expect(useRatingStore().ratingFor(17452)).toBe(4.5)
    expect(useRatingStore().countFor(17452)).toBe(1)
    expect(useRatingStore().ratingFor(6389)).toBe(2)
  })

  test('import RECONCILES: an older backup never rolls back a newer rating', () => {
    const store = useRatingStore()
    store.setRating(7, 5, 5_000) // this device rated it 5, recently
    // A backup taken BEFORE that, with an older record.
    ratingsSlice().write([{ id: 7, rating: 2, count: 1, updatedAt: 1_000 }])
    expect(store.ratingFor(7)).toBe(5)
    expect(store.map['7'].updatedAt).toBe(5_000)

    // A NEWER record from a peer does land.
    ratingsSlice().write([{ id: 7, rating: 3, count: 2, updatedAt: 9_000 }])
    expect(store.ratingFor(7)).toBe(3)
  })

  test('rejects malformed payloads (import is validation-first + atomic)', () => {
    const v = ratingsSlice().validate
    expect(v([{ id: 1, rating: 9, count: 1, updatedAt: 1 }])).toContain('(0, 5]')
    expect(v([{ id: 1, rating: 0, count: 1, updatedAt: 1 }])).toContain('(0, 5]')
    expect(v([{ id: 1, rating: 3, count: 0, updatedAt: 1 }])).toContain('>= 1')
    expect(v([{ id: 1, rating: 3, count: 1 }])).toContain('updatedAt')
    expect(v([{ id: 1, rating: 3, count: 1, updatedAt: 'yesterday' }])).toContain('updatedAt')
    expect(v([{ id: 1, rating: 3, count: 1, updatedAt: -1 }])).toContain('updatedAt')
    expect(v([{ rating: 3, count: 1, updatedAt: 1 }])).toContain('numeric id')
    expect(v([{ id: 'x', rating: 3, count: 1, updatedAt: 1 }])).toContain('numeric id')
    expect(v([{ id: 1, rating: 3, count: 1, updatedAt: 1 }, 7])).toContain('must be objects')
    expect(v({})).toContain('must be an array')
    expect(v([{ id: 1, rating: 3, count: 1, updatedAt: 1 }])).toBeNull()
  })
})

/**
 * The identity slice (ADR-0063). Import is replace-on-apply (device-scoped),
 * but the PRE-JOIN shape ({id:'', name} — a name typed in Settings before
 * the first join) must validate and restore without refusing the whole
 * backup or blanking a minted id (review).
 */
describe('identity slice (ADR-0063 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
  })

  const identitySlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'identity.json')
    if (!slice) throw new Error('identity.json slice missing from STORE_SLICES')
    return slice
  }

  test("a pre-join export ({id:'', name}) validates and round-trips", () => {
      const identity = useIdentityStore()
    // The exact review scenario: rename BEFORE the first join, export.
    identity.rename('Swift Marmot')
    const exported = identitySlice().read() as { id: string; name: string }
    expect(exported).toEqual({ id: '', name: 'Swift Marmot' })
    expect(identitySlice().validate(exported)).toBeNull()

    // Restore on another never-joined device: the name lands, the id stays
    // absent until its own first join (which generate() then keeps).
    useIdentityStore() // fresh
    identitySlice().write(exported)
    expect(identity.name).toBe('Swift Marmot')
    expect(identity.id).toBe('')

    // And a minted id is never blanked by an id-less backup.
    identity.generate()
    const minted = identity.id
    identitySlice().write({ id: '', name: 'Calm Ferret' })
    expect(identity.id).toBe(minted)
    expect(identity.name).toBe('Calm Ferret')
  })

  test('the absent shape stays a no-op; a full identity replaces; garbage is refused', () => {
    const v = identitySlice().validate
    expect(v({ id: '', name: '' })).toBeNull()
    expect(v({ id: '', name: '   ' })).toContain('name must be')
    expect(v({ id: '', name: 'x'.repeat(41) })).toContain('name must be')
    expect(v({ id: 'not-a-uuid', name: 'A' })).toContain('UUID')
    expect(v({ id: '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b', name: '' })).toContain('name must be')

    const UUID = '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
    identitySlice().write({ id: UUID, name: 'Brave Otter' })
    const identity = useIdentityStore()
    expect(identity.id).toBe(UUID)
    expect(identity.name).toBe('Brave Otter')

    identitySlice().write({ id: '', name: '' })
    expect(identity.id).toBe(UUID) // no-op, never blanked
  })
})
