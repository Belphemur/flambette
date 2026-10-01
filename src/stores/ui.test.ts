import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from './ui'

/**
 * The history-sharing default (ADR-0032), which reverses ADR-0011's
 * opt-in. The interesting part is NOT `ref(true)` — it is the migration,
 * because `shareCookedHistory` is persisted per device: on an install
 * that ran the old build, a stored `false` is indistinguishable from
 * "the user never touched it".
 *
 * Persistence itself is a plugin concern; these cases drive the
 * post-hydrate migration directly, which is exactly how the plugin's
 * `afterHydrate` hook calls it.
 */

const UI_KEY = 'mealime-planner:v1:ui'

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    get size() {
      return map.size
    },
  }
}

/** A fresh store, as if the plugin had hydrated it from `blob`. */
function hydratedFrom(blob: Record<string, unknown> | null) {
  ;(globalThis as Record<string, unknown>).localStorage = memoryStorage(
    blob ? { [UI_KEY]: JSON.stringify(blob) } : {},
  )
  const ui = useUiStore()
  if (!blob) return ui
  // Reproduce what pinia-plugin-persistedstate does: patch the picked
  // members from the blob, verbatim.
  for (const key of ['shareCookedHistory', 'historyShareDefaultMigrated'] as const) {
    if (key in blob) (ui as unknown as Record<string, unknown>)[key] = blob[key]
  }
  return ui
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('the history-sharing default is ON (ADR-0032)', () => {
  test('a fresh install syncs history without touching anything', () => {
    const ui = hydratedFrom(null)
    expect(ui.shareCookedHistory).toBe(true)
    expect(ui.historyShareDefaultMigrated).toBe(false) // nothing to migrate yet
  })
})

describe('the one-time default migration', () => {
  test('a pre-ADR-0032 blob (stored false, no marker) adopts the new default', () => {
    // The old build persisted the OLD default on first save, so this is
    // what every existing install looks like — opted out or not, we
    // cannot tell, and the owner's ruling is that history syncs.
    const ui = hydratedFrom({ shareCookedHistory: false, householdRoom: 'amber-falcon-lantern' })
    expect(ui.shareCookedHistory).toBe(false) // hydrated verbatim…
    ui.adoptHistoryShareDefault()
    expect(ui.shareCookedHistory).toBe(true) // …then migrated
    expect(ui.historyShareDefaultMigrated).toBe(true)
  })

  test('a blob that already carries the marker is left alone', () => {
    // The user opted out AFTER the upgrade: an explicit, permanent choice.
    const ui = hydratedFrom({ shareCookedHistory: false, historyShareDefaultMigrated: true })
    ui.adoptHistoryShareDefault()
    expect(ui.shareCookedHistory).toBe(false)
  })

  test('running it twice is a no-op (it cannot flip the user back on)', () => {
    const ui = hydratedFrom({ shareCookedHistory: false })
    ui.adoptHistoryShareDefault()
    ui.shareCookedHistory = false // the user taps the opt-out
    ui.adoptHistoryShareDefault()
    expect(ui.shareCookedHistory).toBe(false)
  })

  test('an unreadable / absent blob still gets the new default', () => {
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    const ui = useUiStore()
    expect(ui.shareCookedHistory).toBe(true)
    ui.adoptHistoryShareDefault()
    expect(ui.shareCookedHistory).toBe(true)
    expect(ui.historyShareDefaultMigrated).toBe(true)
  })

  test('a backup import counts as an explicit choice and blocks the migration', () => {
    const ui = hydratedFrom({ shareCookedHistory: false })
    ui.applySettings({ shareCookedHistory: false })
    expect(ui.historyShareDefaultMigrated).toBe(true)
    ui.adoptHistoryShareDefault()
    expect(ui.shareCookedHistory).toBe(false)
  })
})

/**
 * The Auto-Plan seed generation (ADR-0033), which advances at TWO
 * points: on every successful apply, and on every Regenerate press.
 * These cases pin the two store-level invariants the Auto-Plan dialog
 * depends on — the component owns WHEN to advance, but it can only be
 * correct if peeking and advancing are separate steps.
 */
describe('auto-plan seed generation (ADR-0033)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('nextAutoPlanGeneration PEEKS — reading the seed never advances it', () => {
    const ui = useUiStore()
    expect(ui.nextAutoPlanGeneration()).toBe(0)
    // Two peeks in a row (a run captures the seed, then re-checks it
    // after its await for staleness) must see the SAME value.
    expect(ui.nextAutoPlanGeneration()).toBe(0)
    expect(ui.autoPlanGeneration).toBe(0)
  })

  test('a peeked seed survives a failed run — a stale rebuild consumes nothing', () => {
    const ui = useUiStore()
    const captured = ui.nextAutoPlanGeneration()
    // A run that throws (planner failed) or comes back stale advances
    // nothing on its own: only an explicit advance moves the counter.
    expect(ui.nextAutoPlanGeneration()).toBe(captured)
  })

  test('the apply-time advance rotates the seed', () => {
    const ui = useUiStore()
    expect(ui.nextAutoPlanGeneration()).toBe(0)
    ui.advanceAutoPlanGeneration()
    expect(ui.nextAutoPlanGeneration()).toBe(1)
  })

  test('repeated Regenerate presses advance EXACTLY once each', () => {
    const ui = useUiStore()
    const start = ui.autoPlanGeneration
    for (let press = 1; press <= 4; press++) {
      const seed = ui.nextAutoPlanGeneration()
      ui.advanceAutoPlanGeneration()
      expect(ui.nextAutoPlanGeneration()).toBe(seed + 1)
    }
    expect(ui.autoPlanGeneration).toBe(start + 4)
  })
})
