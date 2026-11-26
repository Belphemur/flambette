/**
 * The in-step timer panel's collapse contract (ADR-0081 addendum
 * 2026-11-26): the bottom strip is the ONE always-visible timer surface,
 * so this panel is a compact disclosure that renders NOTHING about the
 * step's timers until the cook opens it.
 *
 * The two booleans are deliberately a PURE function of the panel state —
 * the single source of truth the cooking view binds, and the unit suite
 * pins, so a later change cannot silently re-introduce a second live
 * countdown beside the strip's chip.
 */

import { formatCountdown, remainingSeconds, type CookTimer } from './stepTimer'
import type { TimerSuggestion } from './timerSuggest'

export interface TimerPanelVisibility {
  /** The expanded panel's Restart/Cancel rows (a running timer exists). */
  showTimerRows: boolean
  /** The creation form (directly for no timer, behind "Set another"). */
  showForm: boolean
}

export function timerPanelVisibility(state: {
  timerCount: number
  panelOpen: boolean
  formOpen: boolean
}): TimerPanelVisibility {
  return {
    showTimerRows: state.panelOpen && state.timerCount > 0,
    // With no running timer the disclosure opens straight onto the form
    // ("Set a Timer"); with one, "Set another timer" is a second explicit
    // tap, so the expanded panel never shows a tall form unprompted.
    showForm: state.panelOpen && (state.timerCount === 0 || state.formOpen),
  }
}

/**
 * The ONE summary line of the collapsed disclosure. A running timer is
 * named with its honest countdown (the panel never duplicates the chip's
 * big countdown, only summarises it); a detected hint is reported as a
 * DETECTION, never as a running timer; otherwise the row says so.
 */
export function timerPanelSummary(
  timers: CookTimer[],
  suggestion: TimerSuggestion | null,
  now: number,
): string {
  if (timers.length > 0) {
    const first = timers[0]
    const count = `${timers.length} ${timers.length === 1 ? 'timer' : 'timers'} running`
    return `${count} · ${first.label} ${formatCountdown(remainingSeconds(first, now))}`
  }
  if (suggestion) return `Detected: ${suggestion.minutes} min — ${suggestion.label}`
  return 'No timer running for this step.'
}
