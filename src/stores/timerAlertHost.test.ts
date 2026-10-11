import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import {
  scanTimerCompletions,
  stopTimerAlertHost,
  unlockTimerAlertAudio,
} from '../lib/timerAlertHost'
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
})

afterEach(() => {
  // A scan that saw armed timers starts the real 1 s interval — the suite
  // drives scans directly, so it must stop the loop between tests.
  stopTimerAlertHost()
})

test('a timer this session watched reaching zero fires ONCE (the pattern)', () => {
  const t0 = 1_000_000
  setTimers({ 5264: { 1: timer(1, 60, t0) } })
  scanTimerCompletions(t0) // armed: 60s left
  expect(vibrateCalls).toEqual([])
  scanTimerCompletions(t0 + 30_000) // still counting
  expect(vibrateCalls).toEqual([])
  scanTimerCompletions(t0 + 61_000) // zero: fire
  expect(vibrateCalls).toEqual([[200, 140, 200, 140, 400]])
  // The 1 s loop keeps ticking — no second alert.
  scanTimerCompletions(t0 + 62_000)
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

test('unlockTimerAlertAudio is gesture-safe without any AudioContext (bun test env)', () => {
  expect(() => unlockTimerAlertAudio()).not.toThrow()
})
