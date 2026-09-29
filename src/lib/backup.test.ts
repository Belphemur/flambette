import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { STORE_SLICES } from './backup'
import { useUiStore } from '../stores/ui'

/**
 * qodo 4128519628 — restoring an OLDER backup (written before
 * dietFilters / householdRoom / stepTimers existed) must RESET those
 * settings, not silently keep the device's current values: the restore
 * dialog claims settings are overwritten.
 */
describe('settings import (ADR-0013 registry)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const settingsSlice = () => {
    const slice = STORE_SLICES.find((s) => s.file === 'settings.json')
    if (!slice) throw new Error('settings.json slice missing from STORE_SLICES')
    return slice
  }

  test('a legacy backup without the new keys resets dietFilters, householdRoom and stepTimers', () => {
    // A store CURRENT value is set by calling write() with a FULL modern
    // backup first.
    settingsSlice().write({
      dietFilters: ['vegan'],
      householdRoom: 'amber-falcon-lantern',
      stepTimers: { 42: { 0: { remaining: 120, running: false, startedAt: null } } },
    })

    // Legacy backup: only the old fields exist.
    settingsSlice().write({ shareCookedHistory: true })

    const ui = useUiStore()
    expect(ui.dietFilters).toEqual([])
    expect(ui.householdRoom).toBe('')
    expect(ui.stepTimers).toEqual({})
    expect(ui.shareCookedHistory).toBe(true)
  })

  test('a modern backup still applies its explicit values', () => {
    settingsSlice().write({
      shareCookedHistory: false,
      dietFilters: ['no-pork', 'no-meat'],
      householdRoom: 'amber-falcon-lantern',
      stepTimers: { 7: { 3: { remaining: 60, running: true, startedAt: 123 } } },
    })
    const ui = useUiStore()
    expect(ui.dietFilters).toEqual(['no-pork', 'no-meat'])
    expect(ui.householdRoom).toBe('amber-falcon-lantern')
    expect(ui.stepTimers[7][3]).toEqual({ remaining: 60, running: true, startedAt: 123 })
  })
})
