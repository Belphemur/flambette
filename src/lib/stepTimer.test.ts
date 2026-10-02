import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TIMER_LABEL,
  MAX_TIMER_LABEL,
  MAX_TIMER_SECONDS,
  TIMER_PRESETS_MIN,
  announceCountdown,
  clampSeconds,
  formatCountdown,
  isFinished,
  isStepTimer,
  newCookTimer,
  newStepTimer,
  nextTimerId,
  normalizeTimerLabel,
  remainingSeconds,
  sameTimerType,
} from './stepTimer'

describe('remainingSeconds', () => {
  test('a paused timer keeps its stored remaining value', () => {
    const t = newStepTimer(90)
    expect(remainingSeconds(t, 1_000_000)).toBe(90)
  })

  test('a running timer counts down from startedAt and never goes negative', () => {
    const startedAt = 10_000
    const t = { remaining: 60, running: true, startedAt }
    expect(remainingSeconds(t, startedAt)).toBe(60)
    expect(remainingSeconds(t, startedAt + 20_000)).toBe(40)
    expect(remainingSeconds(t, startedAt + 600_000)).toBe(0)
    expect(isFinished(t, startedAt + 600_000)).toBe(true)
    expect(isFinished(t, startedAt + 1_000)).toBe(false)
  })

  test('a reload mid-cook resumes honestly (persisted startedAt wins)', () => {
    // Written at t0 with 10 min left, running; the app is closed and
    // reopened 3 minutes later — 7 minutes must be left.
    const persisted = { remaining: 600, running: true, startedAt: 1_700_000_000_000 }
    const reopenedAt = 1_700_000_180_000
    expect(remainingSeconds(persisted, reopenedAt)).toBe(420)
  })

  test('missing / running-without-stamp timers degrade to their remaining value', () => {
    expect(remainingSeconds(undefined)).toBe(0)
    expect(remainingSeconds({ remaining: 30, running: true, startedAt: null })).toBe(30)
  })
})

describe('clampSeconds', () => {
  test('rounds, floors at zero and caps at 6 hours', () => {
    expect(clampSeconds(90.4)).toBe(90)
    expect(clampSeconds(-5)).toBe(0)
    expect(clampSeconds(Number.NaN)).toBe(0)
    expect(clampSeconds(99_999)).toBe(MAX_TIMER_SECONDS)
  })
})

describe('formatCountdown', () => {
  test('m:ss, with hours only when needed', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(45)).toBe('0:45')
    expect(formatCountdown(90)).toBe('1:30')
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(3725)).toBe('1:02:05')
  })
})

describe('announceCountdown', () => {
  test('changes only on minute boundaries (no per-second spam)', () => {
    const a = announceCountdown(120)
    const b = announceCountdown(61)
    expect(a).toBe('2 minutes left')
    expect(b).toBe('2 minutes left') // same bucket → screen readers stay quiet
    expect(announceCountdown(60)).toBe('1 minute left')
    expect(announceCountdown(30)).toBe('30 seconds left')
    expect(announceCountdown(1)).toBe('1 second left')
    expect(announceCountdown(0)).toBe("Time's up")
  })
})

describe('presets', () => {
  test('the documented 1/3/5/10/15/20/30 minute ladder', () => {
    expect([...TIMER_PRESETS_MIN]).toEqual([1, 3, 5, 10, 15, 20, 30])
  })
})

describe('isStepTimer', () => {
  test('accepts well-formed timers only', () => {
    expect(isStepTimer({ remaining: 60, running: false, startedAt: null })).toBe(true)
    expect(isStepTimer({ remaining: 60, running: true, startedAt: 1 })).toBe(true)
    expect(isStepTimer({ remaining: 60, running: 'no', startedAt: null })).toBe(false)
    expect(isStepTimer({ remaining: 60, running: false })).toBe(false)
    expect(isStepTimer(null)).toBe(false)
    expect(isStepTimer([])).toBe(false)
  })
})

/* ---------- Concurrent named timers (ADR-0041) ---------- */

describe('normalizeTimerLabel', () => {
  test('collapses whitespace and never returns an empty chip', () => {
    expect(normalizeTimerLabel('  oven   tray ')).toBe('oven tray')
    expect(normalizeTimerLabel('')).toBe(DEFAULT_TIMER_LABEL)
    expect(normalizeTimerLabel('   ')).toBe(DEFAULT_TIMER_LABEL)
    expect(normalizeTimerLabel(undefined)).toBe(DEFAULT_TIMER_LABEL)
    expect(normalizeTimerLabel(42)).toBe(DEFAULT_TIMER_LABEL)
  })

  test('bounds a long label to the chip budget without a trailing space', () => {
    const long = 'a'.repeat(MAX_TIMER_LABEL) + ' bb'
    // Bounded by the budget, and the cut never leaves a trailing space.
    expect(normalizeTimerLabel(long)).toBe('a'.repeat(MAX_TIMER_LABEL))
  })
})

describe('sameTimerType', () => {
  test('a live chip of the SAME type suppresses the auto-open, case aside', () => {
    // ADR-0041 §4: the gate is per-TYPE, so "Rice" and "rice" are one type…
    expect(sameTimerType('Rice', 'rice')).toBe(true)
    expect(sameTimerType('  RICE ', 'rice')).toBe(true)
    expect(sameTimerType('Rice tray', 'rice tray')).toBe(true)
  })

  test('a live chip of a DIFFERENT type does not (one cook, oven and rice)', () => {
    expect(sameTimerType('Oven', 'Rice')).toBe(false)
    expect(sameTimerType('Shrimp (of 2–3)', 'Step 11 (of 1–2)')).toBe(false)
  })

  test('both sides normalize first: the chip budget can cut the label', () => {
    // The chip label is truncated at MAX_TIMER_LABEL, the suggestion's is
    // not; comparing raw strings would miss exactly the case that matters.
    const suggestion = 'Roasted root vegetables with thyme'
    const armed = newCookTimer(1, suggestion, 600, true)
    expect(armed.label).not.toBe(suggestion) // the chip budget DID cut it
    expect(armed.label.length).toBeLessThanOrEqual(MAX_TIMER_LABEL)
    expect(sameTimerType(armed.label, suggestion)).toBe(true)
  })

  test('an unusable label is the shared "Step" type, never a wildcard', () => {
    expect(sameTimerType('', 'Step')).toBe(true)
    expect(sameTimerType(undefined, 'Step')).toBe(true)
    expect(sameTimerType('', 'Rice')).toBe(false)
  })
})

describe('nextTimerId', () => {
  test('continues past the largest id in use', () => {
    expect(nextTimerId({})).toBe(1)
    expect(nextTimerId({ 1: {}, 4: {} })).toBe(5)
    expect(nextTimerId({ 9: {}, 2: {} })).toBe(10)
  })
})

describe('newCookTimer', () => {
  test('a CookTimer is a StepTimer plus an id and a label (one countdown engine)', () => {
    const t = newCookTimer(2, 'Rice', 720, true, 1000)
    expect(isStepTimer(t)).toBe(true)
    expect(t).toEqual({ id: 2, label: 'Rice', remaining: 720, running: true, startedAt: 1000 })
    expect(remainingSeconds(t, 1000 + 60_000)).toBe(660)
    expect(isFinished(t, 1000 + 720_000)).toBe(true)
  })

  test('clamps the duration and normalizes the label like every other timer', () => {
    const t = newCookTimer(1, '', MAX_TIMER_SECONDS * 10, false)
    expect(t.remaining).toBe(MAX_TIMER_SECONDS)
    expect(t.label).toBe(DEFAULT_TIMER_LABEL)
    expect(t.running).toBe(false)
  })
})
