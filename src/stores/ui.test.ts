import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_SERVINGS } from '../lib/servings'
import { DEFAULT_TIMER_LABEL, MAX_CONCURRENT_TIMERS, MAX_TIMER_LABEL } from '../lib/stepTimer'
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

/* ---------- Display unit system (ADR-0047) ---------- */

describe('unit system (ADR-0047)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('a fresh install is DUAL — the catalog exactly as authored, so output is unchanged', () => {
    expect(useUiStore().unitSystem).toBe('dual')
  })

  test('an explicit choice is remembered, from either affordance', () => {
    const ui = useUiStore()
    ui.setUnitSystem('imperial')
    expect(ui.unitSystem).toBe('imperial')
    ui.setUnitSystem('metric')
    expect(ui.unitSystem).toBe('metric')
    ui.setUnitSystem('dual')
    expect(ui.unitSystem).toBe('dual')
  })

  test('setUnitSystem refuses a value that is not a system', () => {
    const ui = useUiStore()
    for (const bad of ['', 'Metric', 'cups', null, undefined, 1, {}]) {
      ui.setUnitSystem('imperial')
      ui.setUnitSystem(bad)
      expect(ui.unitSystem).toBe('imperial')
    }
  })

  test('repairUnitSystem replaces a hand-edited value, like repairDefaultServings', () => {
    // Hydration is a raw `$patch`, so a hand-edited blob lands verbatim. A
    // value matching no system would silently disable every conversion.
    for (const bad of ['', 'imperial-ish', 'FA', null, 0, {}]) {
      const ui = useUiStore()
      ;(ui as unknown as Record<string, unknown>).unitSystem = bad
      ui.repairUnitSystem()
      expect(ui.unitSystem).toBe('dual')
    }
  })

  test('repairUnitSystem leaves a good value alone', () => {
    const ui = useUiStore()
    ui.setUnitSystem('imperial')
    ui.repairUnitSystem()
    expect(ui.unitSystem).toBe('imperial')
  })

  test('a backup carrying a system applies it; an absent one does not touch it', () => {
    const ui = useUiStore()
    ui.applySettings({ unitSystem: 'imperial' })
    expect(ui.unitSystem).toBe('imperial')
    // A settings.json written before ADR-0047 has no key: restoring it
    // must not flip a device that reads imperial back to the default.
    ui.applySettings({ householdRoom: '' })
    expect(ui.unitSystem).toBe('imperial')
  })

  test('applySettings ignores a malformed system rather than disabling the transform', () => {
    const ui = useUiStore()
    ui.setUnitSystem('imperial')
    ui.applySettings({ unitSystem: 'furlongs' })
    expect(ui.unitSystem).toBe('imperial')
  })
})

/* ---------- Concurrent named timers (ADR-0041) ---------- */

describe('the global timer list (ADR-0041)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('two timers run at once and are listed independently', () => {
    const ui = useUiStore()
    expect(ui.addTimer(7, 'Oven', 25 * 60)).toBe(1)
    expect(ui.addTimer(7, 'Rice', 12 * 60)).toBe(2)

    const list = ui.timers(7)
    expect(list.map((t) => t.label)).toEqual(['Oven', 'Rice'])
    expect(list.map((t) => t.id)).toEqual([1, 2])
    expect(ui.timers(99)).toEqual([])

    // Pausing one leaves the other counting: they are independent jobs.
    ui.pauseTimer(7, 1, 1200)
    expect(ui.timerById(7, 1)?.running).toBe(false)
    expect(ui.timerById(7, 1)?.startedAt).toBeNull()
    expect(ui.timerById(7, 2)?.running).toBe(true)
  })

  test('a cleared timer leaves the others alone, and the recipe key when the last goes', () => {
    const ui = useUiStore()
    ui.addTimer(7, 'Oven', 600)
    ui.addTimer(7, 'Rice', 600)
    ui.clearTimer(7, 1)
    expect(ui.timers(7).map((t) => t.label)).toEqual(['Rice'])
    ui.clearTimer(7, 2)
    expect(ui.stepTimers[7]).toBeUndefined()
  })

  test('a fifth timer is refused and asks for a replacement instead', () => {
    const ui = useUiStore()
    for (let i = 0; i < MAX_CONCURRENT_TIMERS; i++) expect(ui.addTimer(7, `T${i}`, 600)).not.toBeNull()
    expect(ui.isTimerListFull(7)).toBe(true)
    expect(ui.addTimer(7, 'Too many', 600)).toBeNull()
    expect(ui.timers(7)).toHaveLength(MAX_CONCURRENT_TIMERS)

    // Replacing is explicit and keeps the slot count.
    ui.replaceTimer(7, 2, 'Rice', 12 * 60)
    expect(ui.timers(7)).toHaveLength(MAX_CONCURRENT_TIMERS)
    expect(ui.timerById(7, 2)?.label).toBe('Rice')
    expect(ui.timerById(7, 2)?.running).toBe(true)
  })

  test('labels are normalized and bounded; an empty label reads as the step', () => {
    const ui = useUiStore()
    ui.addTimer(7, '  oven   tray ', 600)
    expect(ui.timerById(7, 1)?.label).toBe('oven tray')
    ui.renameTimer(7, 1, 'x'.repeat(MAX_TIMER_LABEL + 10))
    expect(ui.timerById(7, 1)?.label).toHaveLength(MAX_TIMER_LABEL)
    ui.renameTimer(7, 1, '   ')
    expect(ui.timerById(7, 1)?.label).toBe(DEFAULT_TIMER_LABEL)
  })

  test('a pre-ADR-0041 single timer migrates into one named timer (no data dropped)', () => {
    const ui = useUiStore()
    ui.applySettings({ stepTimers: { 42: { 0: { remaining: 720, running: true, startedAt: 111 } } } })
    expect(ui.stepTimers[42][0]).toEqual({
      id: 0,
      label: DEFAULT_TIMER_LABEL,
      remaining: 720,
      running: true,
      startedAt: 111,
    })
  })

  test('a modern map round-trips labels and ids through the import', () => {
    const ui = useUiStore()
    ui.applySettings({
      stepTimers: { 7: { 3: { id: 3, label: 'Rice', remaining: 60, running: true, startedAt: 123 } } },
    })
    expect(ui.stepTimers[7][3]).toEqual({
      id: 3,
      label: 'Rice',
      remaining: 60,
      running: true,
      startedAt: 123,
    })
    // A junk member is dropped, a good one kept (validation-first import).
    ui.applySettings({ stepTimers: { 7: { nope: { remaining: 60, running: true, startedAt: 1 } } } })
    expect(ui.stepTimers[7]).toBeUndefined()
  })
})

/* ---------- Dietary restrictions (the restriction ADR) ---------- */

describe('dietary restrictions (the restriction ADR)', () => {
  test('a fresh install has NO active restriction', () => {
    setActivePinia(createPinia())
    expect(useUiStore().dietaryRestrictionIds).toEqual([])
  })

  test('the sole writer normalizes: unknown ids dropped, dupes collapsed, ascending', () => {
    setActivePinia(createPinia())
    const ui = useUiStore()
    ui.setDietaryRestrictionIds([10, 1, 99, 1, 7, '3'])
    expect(ui.dietaryRestrictionIds).toEqual([1, 3, 10])
    ui.setDietaryRestrictionIds('nonsense')
    expect(ui.dietaryRestrictionIds).toEqual([])
    ui.setDietaryRestrictionIds(undefined)
    expect(ui.dietaryRestrictionIds).toEqual([])
  })

  test('applySettings: present ids apply, ABSENT ids are "don\'t touch"', () => {
    setActivePinia(createPinia())
    const ui = useUiStore()
    ui.setDietaryRestrictionIds([2])
    // A pre-restriction backup has no key: restoring it must not clear the
    // device's restrictions.
    ui.applySettings({ householdRoom: '' })
    expect(ui.dietaryRestrictionIds).toEqual([2])
    ui.applySettings({ dietaryRestrictionIds: [4] })
    expect(ui.dietaryRestrictionIds).toEqual([4])
  })

  test('repairDietaryRestrictionIds normalizes a hand-edited hydrated blob', () => {
    setActivePinia(createPinia())
    const ui = useUiStore()
    ;(ui as unknown as Record<string, unknown>).dietaryRestrictionIds = [14, 8, 1, 1, 'x']
    ui.repairDietaryRestrictionIds()
    expect(ui.dietaryRestrictionIds).toEqual([1, 14])
  })
})
