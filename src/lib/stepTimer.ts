/**
 * Per-step timers for the cooking view (ADR-0020).
 *
 * A timer is stored as `{ remaining, running, startedAt }` rather than a
 * live second counter so it stays HONEST across a reload: the countdown
 * is derived from `remaining - (now - startedAt)` whenever it is running.
 * Everything here is pure and unit-tested; `stores/ui.ts` only holds the
 * map and `CookingView.vue` drives the 1 s tick.
 *
 * ADR-0041 keeps this engine EXACTLY as it is and turns the map's inner
 * key from a step-view index into a timer id, so a recipe can run several
 * named countdowns at once (see `CookTimer` below). Every chip derives its
 * remaining seconds through the same `remainingSeconds`.
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

/* ---------- Concurrent named timers (ADR-0041) ----------
 *
 * ADR-0041 restores ONE global strip and turns the single per-step timer
 * into a LIST of named chips, because a cook juggling an oven and a pot of
 * rice needs both countdowns live at once. The countdown ENGINE is
 * unchanged and shared: a `CookTimer` structurally IS a `StepTimer`
 * (`remaining`/`running`/`startedAt`), so every chip derives its countdown
 * through `remainingSeconds` exactly as before — a persisted id is never
 * re-armed on reload.
 */

/** Free-text chip label budget (a chip is narrow on a Pixel 7). */
export const MAX_TIMER_LABEL = 24

/**
 * Screen-space cap on CONCURRENT timers. Adding beyond it asks which timer
 * to replace rather than growing the strip (ADR-0041 §2).
 */
export const MAX_CONCURRENT_TIMERS = 4

/**
 * Label for a timer the user never named — also what a pre-ADR-0041
 * persisted record migrates to, so an imported timer keeps its countdown
 * and simply reads as the step's own timer.
 */
export const DEFAULT_TIMER_LABEL = 'Step'

/** A named, concurrently-running timer chip (ADR-0041). */
export interface CookTimer extends StepTimer {
  /** Stable key within the recipe's timer map. */
  id: number
  /** User- or recipe-authored chip label, ≤ `MAX_TIMER_LABEL`. */
  label: string
}

/**
 * Coerce a chip label: whitespace-collapsed, trimmed, never empty and
 * never longer than `MAX_TIMER_LABEL`. Anything unusable becomes
 * `DEFAULT_TIMER_LABEL` so a chip always names something.
 */
export function normalizeTimerLabel(label: unknown): string {
  const text = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim() : ''
  if (!text) return DEFAULT_TIMER_LABEL
  return text.length > MAX_TIMER_LABEL ? text.slice(0, MAX_TIMER_LABEL).trimEnd() : text
}

/**
 * Do two chip labels name the same TYPE of work? ADR-0041 §4: the
 * auto-open gate is per-TYPE, so a live "Oven" must not suppress a
 * "Rice" suggestion (and vice versa) — one cook holds an oven AND a pot
 * of rice, and both pre-fills are legitimate at once.
 *
 * Case- and whitespace-insensitive, both sides normalized through
 * `normalizeTimerLabel` first (a chip's label is truncated at
 * `MAX_TIMER_LABEL`, the suggestion's is not, so comparing the RAW
 * strings would miss the very case that matters most: the chip reading
 * back exactly what was armed).
 */
export function sameTimerType(a: unknown, b: unknown): boolean {
  const left = normalizeTimerLabel(a).toLowerCase()
  const right = normalizeTimerLabel(b).toLowerCase()
  return left === right
}

/**
 * A fresh timer for `id`. `startedAt` is the CALLER's stamp: this stays
 * pure so a store action owns the one `Date.now()` in the path (and a
 * test never races the clock).
 */
export function newCookTimer(
  id: number,
  label: unknown,
  seconds: number,
  running = true,
  startedAt: number | null = null,
): CookTimer {
  return {
    id,
    label: normalizeTimerLabel(label),
    ...newStepTimer(seconds),
    running,
    startedAt,
  }
}

/**
 * Next free timer id for a recipe's timer map: one past the largest key in
 * use. Derived from the map rather than kept in its own counter, so a
 * backup/room payload that arrives with ids already in use cannot collide
 * and there is nothing extra to persist.
 */
export function nextTimerId(timers: Record<number, unknown>): number {
  let max = 0
  for (const key of Object.keys(timers)) {
    const n = Number(key)
    if (Number.isFinite(n) && n > max) max = Math.floor(n)
  }
  return max + 1
}



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
