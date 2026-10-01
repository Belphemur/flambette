import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_SERVINGS } from '../lib/servings'
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

/**
 * The remembered default serving size (ADR-0037). The store owns two
 * invariants the components rely on: a change is remembered, and a value
 * that reached the ref by any route other than a setter is repaired
 * before it can scale a recipe.
 */
describe('default servings (ADR-0037)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('a fresh install starts at the authored 6', () => {
    // The whole point of the fallback: an install that never touches the
    // control behaves exactly as it did before this existed.
    expect(useUiStore().defaultServings).toBe(6)
  })

  test('an explicit change is remembered', () => {
    const ui = useUiStore()
    ui.setDefaultServings(4)
    expect(ui.defaultServings).toBe(4)
    ui.setDefaultServings(2)
    expect(ui.defaultServings).toBe(2)
  })

  test('a stepper at the floor is a no-op, not a reset to 1', () => {
    // `servings--` at 1 sends 0. Storing that would re-scope every future
    // recipe to a single portion — the floor belongs to the row, not the
    // remembered default.
    const ui = useUiStore()
    ui.setDefaultServings(4)
    ui.setDefaultServings(0)
    expect(ui.defaultServings).toBe(4)
  })

  test('an out-of-range write is clamped', () => {
    const ui = useUiStore()
    ui.setDefaultServings(1e9)
    expect(ui.defaultServings).toBe(MAX_SERVINGS)
  })

  test('a stepper at the ceiling stores the ceiling, never one past it', () => {
    // Both steppers clamp BEFORE writing (CodeRabbit + qodo round 1): a
    // sheet showing 100 while the memory held 99 would display one number
    // and cook another, since CookingView freezes from the stored value.
    const ui = useUiStore()
    ui.setDefaultServings(MAX_SERVINGS - 1)
    ui.setDefaultServings(MAX_SERVINGS) // a `+` press AT the cap
    expect(ui.defaultServings).toBe(MAX_SERVINGS)
  })

  test('repairDefaultServings replaces a hydrated value that cannot scale a recipe', () => {
    // Hydration is a raw `$patch` of localStorage, so a hand-edited or
    // truncated blob lands verbatim. Unlike a label, this value is
    // arithmetic: 0 collapses a recipe, 1e9 makes quantities unusable.
    for (const bad of [0, -4, NaN, 1e9, 'four', null]) {
      const ui = useUiStore()
      ;(ui as unknown as Record<string, unknown>).defaultServings = bad
      ui.repairDefaultServings()
      expect(ui.defaultServings).toBe(6)
    }
  })

  test('repairDefaultServings leaves a good value alone', () => {
    const ui = useUiStore()
    ui.setDefaultServings(4)
    ui.repairDefaultServings()
    expect(ui.defaultServings).toBe(4)
  })

  test('a backup carrying a default restores it', () => {
    const ui = useUiStore()
    ui.applySettings({ defaultServings: 3 })
    expect(ui.defaultServings).toBe(3)
  })

  test('an ABSENT defaultServings is "don\'t touch" — a legacy backup keeps the device value', () => {
    const ui = useUiStore()
    ui.setDefaultServings(5)
    // A settings.json written before ADR-0037 has no key. Restoring it
    // must not silently discard what this device already remembers.
    ui.applySettings({ householdRoom: '' })
    expect(ui.defaultServings).toBe(5)
  })
})
