/**
 * Per-step timers for the cooking view (ADR-0020).
 *
 * A timer is stored as `{ remaining, running, startedAt }` rather than a
 * live second counter so it stays HONEST across a reload: the countdown
 * is derived from `remaining - (now - startedAt)` whenever it is running.
 * Everything here is pure and unit-tested; `stores/ui.ts` only holds the
 * map and `CookingView.vue` drives the 1 s tick.
 */

export interface StepTimer {
  /** Seconds left when the current run segment started (or at pause). */
  remaining: number
  /** True while the countdown is running. */
  running: boolean
  /** Epoch ms when the current run segment began; null when paused. */
  startedAt: number | null
}

/** Preset durations, in minutes (ADR-0020 — one tap to start). */
export const TIMER_PRESETS_MIN: readonly number[] = [1, 3, 5, 10, 15, 20, 30]

/** Upper bound on a persisted/entered duration: 6 hours. */
export const MAX_TIMER_SECONDS = 6 * 60 * 60

/** A fresh, paused timer for `seconds`. */
export function newStepTimer(seconds: number): StepTimer {
  return { remaining: clampSeconds(seconds), running: false, startedAt: null }
}

export function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(Math.round(seconds), MAX_TIMER_SECONDS)
}

/**
 * Seconds left right now. A running timer's remaining value is the
 * countdown base it had when `startedAt` was stamped; a paused one is
 * already its own remaining value. Never negative.
 */
export function remainingSeconds(timer: StepTimer | undefined, now: number = Date.now()): number {
  if (!timer) return 0
  if (!timer.running) return clampSeconds(timer.remaining)
  if (timer.startedAt === null) return clampSeconds(timer.remaining)
  return clampSeconds(timer.remaining - (now - timer.startedAt) / 1000)
}

/** True when a running timer has already hit zero. */
export function isFinished(timer: StepTimer | undefined, now: number = Date.now()): boolean {
  return !!timer && timer.running && remainingSeconds(timer, now) <= 0
}

/** `45` → `0:45`, `90` → `1:30`, `3725` → `1:02:05`, `0` → `0:00`. */
export function formatCountdown(seconds: number): string {
  const total = clampSeconds(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Spoken form for the polite live region. It changes ONLY on minute
 * boundaries (and at zero), so the countdown never floods a screen
 * reader with per-second announcements (ADR-0020).
 */
export function announceCountdown(seconds: number): string {
  const total = clampSeconds(seconds)
  if (total <= 0) return "Time's up"
  if (total < 60) return `${total} second${total === 1 ? '' : 's'} left`
  const minutes = Math.ceil(total / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'} left`
}

/** Shape guard for persisted / imported timer maps (backup validation). */
export function isStepTimer(value: unknown): value is StepTimer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  return (
    typeof t.remaining === 'number' && Number.isFinite(t.remaining) &&
    typeof t.running === 'boolean' &&
    (t.startedAt === null || (typeof t.startedAt === 'number' && Number.isFinite(t.startedAt)))
  )
}
