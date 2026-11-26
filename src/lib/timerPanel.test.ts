import { describe, expect, test } from 'bun:test'
import { timerPanelSummary, timerPanelVisibility } from './timerPanel'
import type { CookTimer } from './stepTimer'
import type { TimerSuggestion } from './timerSuggest'

function timer(id: number, label: string, remaining: number): CookTimer {
  return { id, label, remaining, total: remaining, running: true, startedAt: 1_000 }
}

describe('in-step timer panel (ADR-0081 addendum 2026-11-26)', () => {
  test('no timer and no hint: collapsed "Set a Timer", no duplicate countdown', () => {
    expect(timerPanelSummary([], null, 1_000)).toBe('No timer running for this step.')
    expect(timerPanelVisibility({ timerCount: 0, panelOpen: false, formOpen: false })).toEqual({
      showTimerRows: false,
      showForm: false,
    })
    // The explicit tap reveals ONLY the creation form — there is no
    // running-timer row to duplicate the bottom strip's chip.
    expect(timerPanelVisibility({ timerCount: 0, panelOpen: true, formOpen: false })).toEqual({
      showTimerRows: false,
      showForm: true,
    })
  })

  test('a running timer is summarised, and its Restart/Cancel rows stay behind the disclosure', () => {
    const t0 = 1_000
    const t = timer(1, 'Step', 125)
    expect(timerPanelSummary([t], null, t0)).toBe('1 timer running · Step 2:05')
    // Collapsed by default even with a live timer: the bottom chip is
    // the only always-visible surface.
    expect(timerPanelVisibility({ timerCount: 1, panelOpen: false, formOpen: false })).toEqual({
      showTimerRows: false,
      showForm: false,
    })
    const open = timerPanelVisibility({ timerCount: 1, panelOpen: true, formOpen: false })
    expect(open.showTimerRows).toBe(true) // Restart/Cancel reachable
    expect(open.showForm).toBe(false) // "Set another timer" is a second tap
    expect(
      timerPanelVisibility({ timerCount: 1, panelOpen: true, formOpen: true }).showForm,
    ).toBe(true)
  })

  test('a detected hint is a summary, not a fake running timer', () => {
    const suggestion: TimerSuggestion = {
      label: 'Soup',
      minutes: 10,
      seconds: 600,
      secondsLow: 600,
    }
    expect(timerPanelSummary([], suggestion, 1_000)).toBe('Detected: 10 min — Soup')
    expect(timerPanelVisibility({ timerCount: 0, panelOpen: false, formOpen: false })).toEqual({
      showTimerRows: false,
      showForm: false,
    })
    // Expanding shows the honest one-tap offer, never a countdown.
    expect(timerPanelVisibility({ timerCount: 0, panelOpen: true, formOpen: false })).toEqual({
      showTimerRows: false,
      showForm: true,
    })
  })

  test('several timers are summarised by count and the oldest label', () => {
    const t0 = 1_000
    const timers = [timer(1, 'Oven', 61), timer(2, 'Rice', 300)]
    expect(timerPanelSummary(timers, null, t0)).toBe('2 timers running · Oven 1:01')
  })
})
