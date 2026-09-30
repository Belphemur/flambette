import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { STORE_SLICES } from './backup'
import { useUiStore } from '../stores/ui'

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

  test('a legacy backup without the new keys resets quickFilters, householdRoom and stepTimers', () => {
    // A store CURRENT value is set by calling write() with a FULL modern
    // backup first.
    settingsSlice().write({
      quickFilters: { diets: ['vegan'], protein: 'fish', maxTime: 30, sortBy: 'time', favOnly: true, proOnly: false },
      householdRoom: 'amber-falcon-lantern',
      stepTimers: { 42: { 0: { remaining: 120, running: false, startedAt: null } } },
    })

    // Legacy backup: only the old fields exist.
    settingsSlice().write({ shareCookedHistory: true })

    const ui = useUiStore()
    expect(ui.quickFilters).toEqual({
      diets: [],
      protein: '',
      maxTime: null,
      sortBy: 'rating',
      favOnly: false,
      proOnly: false,
    })
    expect(ui.householdRoom).toBe('')
    expect(ui.stepTimers).toEqual({})
    expect(ui.shareCookedHistory).toBe(true)
  })

  test('a modern backup still applies its explicit values', () => {
    settingsSlice().write({
      shareCookedHistory: false,
      quickFilters: {
        diets: ['no-pork', 'no-meat'],
        protein: 'meat',
        maxTime: 45,
        sortBy: 'calories',
        favOnly: false,
        proOnly: true,
      },
      householdRoom: 'amber-falcon-lantern',
      stepTimers: { 7: { 3: { remaining: 60, running: true, startedAt: 123 } } },
    })
    const ui = useUiStore()
    expect(ui.quickFilters).toEqual({
      diets: ['no-pork', 'no-meat'],
      protein: 'meat',
      maxTime: 45,
      sortBy: 'calories',
      favOnly: false,
      proOnly: true,
    })
    expect(ui.householdRoom).toBe('amber-falcon-lantern')
    expect(ui.stepTimers[7][3]).toEqual({ remaining: 60, running: true, startedAt: 123 })
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
