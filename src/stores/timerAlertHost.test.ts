import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import {
  alarmingTimers,
  resetTimerAlertHostForTests,
  scanTimerCompletions,
  stopTimerAlertHost,
  timerAlertLoopRunning,
  unlockTimerAlertAudio,
} from '../lib/timerAlertHost'
import { chimeTonesForOrdinal } from '../lib/timerAlert'
import { useUiStore } from './ui'
import type { StepTimer, StepTimersMap } from '../lib/stepTimer'

/**
 * The device-level timer completion host (ADR-0081 timer-alert amendment).
 * The suite drives `scanTimerCompletions` with controlled wall-clock
 * values — the interval is a mechanical 1 s loop, the DECISIONS live in
 * the scan: one fire per transition into zero, keyed per recipe+timer,
 * and silent seeding for timers already expired at first sight.
 */

const vibrateCalls: unknown[] = []
const realVibrate = (navigator as Navigator & { vibrate?: unknown }).vibrate
Object.defineProperty(navigator, 'vibrate', {
  configurable: true,
  value: (pattern: unknown) => {
    vibrateCalls.push(pattern)
    return true
  },
})

/* ---------- Chime observability (ADR-0093 pitch) ----------
 *
 * The host constructs its own engine through the NATIVE AudioContext
 * path, so the pitch suite installs a stub constructor on globalThis:
 * every chime tone records its frequency, and the oscillator pair per
 * fire is exactly two entries (low tone, then high tone).
 */
const chimeTones: { freq: number }[] = []
const hadNativeAudioContext = 'AudioContext' in globalThis
class StubChimeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {} as AudioNode
  resume(): Promise<void> {
    return Promise.resolve()
  }
  createOscillator(): OscillatorNode {
    const rec = { freq: 0 }
    chimeTones.push(rec)
    const osc = {
      type: 'sine',
      frequency: {
        get value(): number {
          return rec.freq
        },
        set value(v: number) {
          rec.freq = v
        },
      },
      connect: () => osc,
      start: () => {},
      stop: () => {},
    }
    return osc as unknown as OscillatorNode
  }
  createGain(): GainNode {
    const gain = {
      gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
      connect: () => gain,
    }
    return gain as unknown as GainNode
  }
}
;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = StubChimeAudioContext

function timer(id: number, seconds: number, startedAt: number, running = true): StepTimer {
  return { id, label: `T${id}`, seconds, startedAt, running, remaining: seconds }
}

function setTimers(map: StepTimersMap) {
  const ui = useUiStore()
  ui.stepTimers = map
}

beforeEach(() => {
  setActivePinia(createPinia())
  vibrateCalls.length = 0
  chimeTones.length = 0
  // The host state is module-level BY DESIGN (it outlives a cook view),
  // so tests must not leak armed/alerted/alarming keys into each other —
  // a test ending on a Restart leaves an armed-but-unalerted key that
  // would fire spuriously in the next test reusing the same recipe id.
  resetTimerAlertHostForTests()
})

afterAll(() => {
  if (!hadNativeAudioContext) {
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
  }
})

afterEach(() => {
  // A scan that saw armed timers starts the real 1 s interval — the suite
  // drives scans directly, so it must stop the loop between tests.
  stopTimerAlertHost()
})

test('round 1 fires on the expiry tick — and only that round (ADR-0093)', () => {
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0) } })
  scanTimerCompletions(t0) // armed: 60s left
  expect(vibrateCalls).toEqual([])
  scanTimerCompletions(t0 + 30_000) // still counting
  expect(vibrateCalls).toEqual([])
  scanTimerCompletions(t0 + 61_000) // zero: round 1
  expect(vibrateCalls).toEqual([[200, 140, 200, 140, 400]])
  // The SAME tick repeated (idempotent) and a scan inside the 2 s pause
  // add no second alert — the next round is due at +2 s.
  scanTimerCompletions(t0 + 61_000)
  scanTimerCompletions(t0 + 62_500)
  expect(vibrateCalls).toHaveLength(1)
  // The user RESTARTS: the countdown is live again, the alarm stops.
  setTimers({ 5264: { 1: timer(1, 60, t0 + 70_000) } })
  scanTimerCompletions(t0 + 71_000)
  scanTimerCompletions(t0 + 90_000)
  expect(vibrateCalls).toHaveLength(1)
})

test('a timer ALREADY expired at first sight is seeded silently (no boot buzz)', () => {
  const t0 = 1_000_000
  // Started two hours before the app opened.
  setTimers({ 5264: { 1: timer(1, 60, t0 - 7_200_000) } })
  scanTimerCompletions(t0)
  scanTimerCompletions(t0 + 5_000)
  expect(vibrateCalls).toEqual([])
})

test('keys are per recipe+timer: the same numeric id in another recipe fires for itself', () => {
  const t0 = 1_000_000
  // Recipe A's timer 1 already alerted; recipe B independently allocated id 1.
  setTimers({
    5264: { 1: timer(1, 60, t0 - 120_000) },
    11481: { 1: timer(1, 60, t0) },
  })
  scanTimerCompletions(t0) // A seeds silently (expired), B arms
  scanTimerCompletions(t0 + 61_000)
  expect(vibrateCalls).toHaveLength(1)
})

test('a restarted timer re-arms: it fires again when the new run reaches zero', () => {
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0) } })
  scanTimerCompletions(t0)
  scanTimerCompletions(t0 + 61_000)
  expect(vibrateCalls).toHaveLength(1)
  // Restart (ui.startTimer semantics): a fresh startedAt, still "running".
  setTimers({ 5264: { 1: timer(1, 60, t0 + 70_000) } })
  scanTimerCompletions(t0 + 71_000)
  expect(vibrateCalls).toHaveLength(1) // armed again, not yet zero
  scanTimerCompletions(t0 + 131_000)
  expect(vibrateCalls).toHaveLength(2)
})

test('the vibration toggle is read at FIRE time (device-local, never captured)', () => {
  const ui = useUiStore()
  ui.timerAlertVibrate = false
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0) } })
  scanTimerCompletions(t0)
  scanTimerCompletions(t0 + 61_000)
  expect(vibrateCalls).toEqual([])
})

test('a cleared timer forgets its alert; a paused one never fires early', () => {
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0), 2: timer(2, 300, t0, false) } })
  scanTimerCompletions(t0)
  scanTimerCompletions(t0 + 61_000)
  expect(vibrateCalls).toHaveLength(1)
  // Timer 1 cleared, timer 2 paused (still counting, never reaches zero).
  setTimers({ 5264: { 2: timer(2, 300, t0, false) } })
  scanTimerCompletions(t0 + 120_000)
  expect(vibrateCalls).toHaveLength(1)
})

test('a timer cleared mid-countdown is FORGOTTEN — a restored id that arrives expired never fires', () => {
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0) } })
  scanTimerCompletions(t0) // armed
  // The cook cancels it while it counts: the cleanup walk must forget
  // the ARMED key too (an `alerted`-only walk leaks it), or a later
  // restore that re-creates 5264:1 already expired fires spuriously.
  setTimers({ 5264: {} })
  scanTimerCompletions(t0 + 10_000)
  setTimers({ 5264: { 1: timer(1, 60, t0 - 7_200_000) } })
  scanTimerCompletions(t0 + 20_000)
  scanTimerCompletions(t0 + 25_000)
  expect(vibrateCalls).toEqual([])
})

test('unlockTimerAlertAudio is gesture-safe without any AudioContext (bun test env)', () => {
  expect(() => unlockTimerAlertAudio()).not.toThrow()
})

/* ---------- Recurring escalating alarm (ADR-0093) ---------- */

describe('recurring escalating alarm (ADR-0093)', () => {
  test('the alarm repeats in rounds and the pause grows 2/4/8/16 → the 30 s cap', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0) // armed
    scanTimerCompletions(t0 + 61_000) // round 1 on the expiry tick
    expect(vibrateCalls).toHaveLength(1)
    scanTimerCompletions(t0 + 63_000) // +2 s → round 2
    expect(vibrateCalls).toHaveLength(2)
    scanTimerCompletions(t0 + 66_000) // +4 s due at 67_000 — not yet
    expect(vibrateCalls).toHaveLength(2)
    scanTimerCompletions(t0 + 67_000) // → round 3
    expect(vibrateCalls).toHaveLength(3)
    scanTimerCompletions(t0 + 75_000) // +8 s → round 4
    expect(vibrateCalls).toHaveLength(4)
    scanTimerCompletions(t0 + 91_000) // +16 s → round 5
    expect(vibrateCalls).toHaveLength(5)
    scanTimerCompletions(t0 + 121_000) // +30 s cap → round 6
    expect(vibrateCalls).toHaveLength(6)
    scanTimerCompletions(t0 + 151_000) // the cap holds: 30 s again
    expect(vibrateCalls).toHaveLength(7)
  })

  test('Clear stops the alarm (a vanished key is a user stop)', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0)
    scanTimerCompletions(t0 + 61_000) // round 1
    expect(vibrateCalls).toHaveLength(1)
    setTimers({ 5264: {} }) // the cook cancels the timer
    scanTimerCompletions(t0 + 65_000) // inside what would have been the 2 s pause
    scanTimerCompletions(t0 + 95_000) // and long after
    expect(vibrateCalls).toHaveLength(1)
  })

  test('a fresh run after Restart alarms again from round 1 (the alarm state resets)', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0)
    scanTimerCompletions(t0 + 61_000) // round 1
    scanTimerCompletions(t0 + 63_000) // round 2
    expect(vibrateCalls).toHaveLength(2)
    setTimers({ 5264: { 1: timer(1, 60, t0 + 70_000) } }) // Restart
    scanTimerCompletions(t0 + 71_000)
    scanTimerCompletions(t0 + 100_000)
    expect(vibrateCalls).toHaveLength(2)
    scanTimerCompletions(t0 + 131_000) // the new run reaches zero
    expect(vibrateCalls).toHaveLength(3)
    scanTimerCompletions(t0 + 132_000) // …and it escalates from the 2 s pause again
    expect(vibrateCalls).toHaveLength(3)
  })

  test('the loop keeps itself alive while alarming even though nothing is counting', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0)
    scanTimerCompletions(t0 + 61_000) // round 1 — the timer is expired, not counting
    expect(vibrateCalls).toHaveLength(1)
    // A later scan (what the real 1 s interval would deliver) still lands
    // the next round — the host did not stop at the expiry tick.
    scanTimerCompletions(t0 + 63_000)
    expect(vibrateCalls).toHaveLength(2)
  })

  test("each timer's round is pitched by its ordinal among the recipe's timers", () => {
    const t0 = 1_000_000
    // Both timers of one recipe; the strip order is oldest id first.
    setTimers({ 5264: { 2: timer(2, 120, t0), 1: timer(1, 60, t0) } })
    unlockTimerAlertAudio()
    scanTimerCompletions(t0) // both armed
    expect(chimeTones).toEqual([])
    scanTimerCompletions(t0 + 61_000) // timer id 1 → ordinal 0: today's A5→D6
    expect(chimeTones.map((t) => t.freq)).toEqual([880, 1174.66])
    scanTimerCompletions(t0 + 63_000) // its round 2 — SAME pitch
    expect(chimeTones.slice(-2).map((t) => t.freq)).toEqual([880, 1174.66])
    scanTimerCompletions(t0 + 121_000) // timer id 2 → ordinal 1: +2 semitones
    const [lo, hi] = chimeTonesForOrdinal(1)
    expect(Math.abs(chimeTones.at(-2)!.freq - lo)).toBeLessThan(0.01)
    expect(Math.abs(chimeTones.at(-1)!.freq - hi)).toBeLessThan(0.01)
    // Strictly higher than timer 1's tones — the ear can tell them apart.
    expect(chimeTones.at(-2)!.freq).toBeGreaterThan(880)
  })

  test('a ringing timer keeps its voice when a lower-id timer is cleared (round-1 ordinal capture)', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 2: timer(2, 120, t0), 1: timer(1, 60, t0) } })
    unlockTimerAlertAudio()
    scanTimerCompletions(t0) // both armed
    scanTimerCompletions(t0 + 61_000) // timer 1 → ordinal 0
    scanTimerCompletions(t0 + 63_000) // timer 1 round 2
    scanTimerCompletions(t0 + 121_000) // timer 2 → ordinal 1
    const [, hi] = chimeTonesForOrdinal(1)
    expect(Math.abs(chimeTones.at(-1)!.freq - hi)).toBeLessThan(0.01)
    // The cook CLEARS timer 1 while timer 2 is still ringing: timer 2's
    // next round must NOT drop to the freed ordinal 0 — the pitch was
    // captured at its round 1 (ADR-0093: the ear tells timers apart).
    setTimers({ 5264: { 2: timer(2, 120, t0) } })
    scanTimerCompletions(t0 + 151_000) // timer 2's next round is due
    expect(Math.abs(chimeTones.at(-1)!.freq - hi)).toBeLessThan(0.01)
    expect(chimeTones.at(-1)!.freq).toBeGreaterThan(1000) // never the base D6 pair
  })

  test('a backup restore that re-creates the same ids drops the old alarm and never inherits its rounds', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0) // armed
    scanTimerCompletions(t0 + 61_000) // round 1
    expect(vibrateCalls).toHaveLength(1)
    // A rename does NOT drop the alarm (a label is not a stop — only the
    // run segment identifies the alarmed record):
    setTimers({ 5264: { 1: { ...timer(1, 60, t0), label: 'Renamed' } } })
    scanTimerCompletions(t0 + 63_000) // round 2 due
    expect(vibrateCalls).toHaveLength(2)
    // A backup import replaces the record wholesale: same variantId and
    // timer id, a DIFFERENT run segment (already expired). The old alarm
    // is not this record's alarm — it must stop, and the restored record
    // is seeded silently (never re-fires).
    setTimers({ 5264: { 1: timer(1, 60, t0 - 7_200_000) } })
    scanTimerCompletions(t0 + 123_000) // what would have been round 3
    scanTimerCompletions(t0 + 183_000) // and every later due moment
    expect(vibrateCalls).toHaveLength(2)
    expect(alarmingTimers.value).toEqual([])
  })

  test('the banner mirror lists the ringing timers by label and empties when the alarm stops', () => {
    const t0 = 1_000_000
    setTimers({ 5264: { 2: timer(2, 120, t0), 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0)
    expect(alarmingTimers.value).toEqual([])
    scanTimerCompletions(t0 + 61_000) // timer 1 rings
    expect(alarmingTimers.value).toEqual([{ variantId: 5264, timerId: 1, label: 'T1' }])
    scanTimerCompletions(t0 + 121_000) // timer 2 joins
    expect(alarmingTimers.value).toEqual([
      { variantId: 5264, timerId: 1, label: 'T1' },
      { variantId: 5264, timerId: 2, label: 'T2' },
    ])
    setTimers({ 5264: {} }) // the cook clears both
    scanTimerCompletions(t0 + 125_000)
    expect(alarmingTimers.value).toEqual([])
  })

  test('with BOTH channels dead the host never enters the alarming set — no invisible 1 s loop', () => {
    const ui = useUiStore()
    ui.timerAlertSound = false
    ui.timerAlertVibrate = false
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0) // armed
    scanTimerCompletions(t0 + 61_000) // expiry: round 1 would be due
    expect(vibrateCalls).toEqual([])
    // Nothing is ringing, so nothing is alarming and the loop's OWN stop
    // condition fired — no permanent 1 s interval parked on an expired
    // timer nobody can hear (kody: the setInterval leak).
    expect(alarmingTimers.value).toEqual([])
    expect(timerAlertLoopRunning()).toBe(false)
    scanTimerCompletions(t0 + 120_000)
    expect(vibrateCalls).toEqual([])
  })

  test('turning the last channel OFF mid-alarm stops it (the flip is a user stop)', () => {
    const ui = useUiStore()
    const t0 = 1_000_000
    setTimers({ 5264: { 1: timer(1, 60, t0) } })
    scanTimerCompletions(t0)
    scanTimerCompletions(t0 + 61_000) // round 1 (both channels on)
    expect(vibrateCalls).toHaveLength(1)
    ui.timerAlertSound = false
    ui.timerAlertVibrate = false
    scanTimerCompletions(t0 + 63_000) // round 2 would be due
    expect(vibrateCalls).toHaveLength(1)
    expect(alarmingTimers.value).toEqual([])
    // Re-enabling later does NOT resurrect the stopped alarm.
    ui.timerAlertSound = true
    scanTimerCompletions(t0 + 95_000)
    expect(vibrateCalls).toHaveLength(1)
  })
})
