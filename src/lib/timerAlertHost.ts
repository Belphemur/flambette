/**
 * The device-level timer completion host (ADR-0081 timer-alert amendment).
 *
 * Completion alerts are a property of the PERSISTED timer state, not of the
 * cooking view: a cook who leaves the cooking route while a timer runs must
 * still be told when it reaches zero. This singleton watches `ui.stepTimers`
 * on a 1 s interval and fires the alert engine ONCE per timer transition into
 * zero — keyed by `variantId:timerId` (timer ids are allocated per recipe, so
 * a bare id could collide across recipes).
 *
 * Seeding rule (the mount problem): a timer that is ALREADY expired when this
 * app session first sees it is marked alerted SILENTLY — a timer that
 * finished before the app even opened must not buzz on boot. Only a timer
 * this session saw counting (armed) and then saw reach zero fires.
 *
 * Autoplay discipline is unchanged: the AudioContext is created/resumed only
 * inside a user gesture (`unlockTimerAlertAudio`, called from the Start-timer
 * and Restart presses); a chime without a gesture degrades silently to the
 * announcement + vibration. Polling starts lazily and stops itself when no
 * timer is live and every expired one has been accounted for.
 */

import { useUiStore } from '../stores/ui'
import { remainingSeconds, type CookTimer } from './stepTimer'
import { createTimerAlerts, type TimerAlerts } from './timerAlert'

let engine: TimerAlerts | null = null
let handle: ReturnType<typeof setInterval> | undefined
/** Keys this session SAW counting down (armed) — only they may fire. */
const armed = new Set<string>()
/** Keys that have fired (or were seeded as already-expired). */
const alerted = new Set<string>()

function keyOf(variantId: number, timerId: number): string {
  return `${variantId}:${timerId}`
}

function ensureEngine(): TimerAlerts {
  engine ??= createTimerAlerts(() => {
    const ui = useUiStore()
    return { sound: ui.timerAlertSound, vibrate: ui.timerAlertVibrate }
  })
  return engine
}

/**
 * Create/resume the AudioContext inside a user gesture. Cheap to call
 * repeatedly (resuming a running context is a no-op); never throws.
 */
export function unlockTimerAlertAudio(): void {
  ensureEngine().unlock()
}

function tick(now: number): void {
  const ui = useUiStore()
  const seen = new Set<string>()
  let live = false
  for (const [rawVariantId, timers] of Object.entries(ui.stepTimers)) {
    const variantId = Number(rawVariantId)
    for (const t of Object.values(timers ?? {}) as (CookTimer | undefined)[]) {
      if (!t) continue
      const key = keyOf(variantId, t.id)
      seen.add(key)
      const left = remainingSeconds(t, now)
      if (left > 0) {
        // Counting (again): forget any past alert so a re-armed timer
        // fires again when THIS run reaches zero.
        armed.add(key)
        alerted.delete(key)
        live = true
      } else if (armed.has(key) && !alerted.has(key)) {
        // This session watched it reach zero: fire once.
        alerted.add(key)
        ensureEngine().fire()
      } else {
        // Already expired when first seen (app boot, or a timer that
        // expired while the interval was stopped): seed silently.
        alerted.add(key)
      }
    }
  }
  // Forget every key of THIS recipe set that vanished while we were not
  // looking (a timer cleared mid-countdown, a backup that rewrote the
  // map): iterate the UNION — a key that is armed-but-never-alerted is
  // exactly the leak a `alerted`-only walk misses, and a stale armed key
  // would fire a spurious alert if a later restore re-created that id
  // already expired (the seeding rule would never see it count).
  for (const key of [...alerted, ...armed]) {
    if (!seen.has(key)) {
      alerted.delete(key)
      armed.delete(key)
    }
  }
  if (!live && alerted.size === seen.size) {
    stopTimerAlertHost()
  } else if (armed.size > 0 && handle === undefined) {
    // Something is counting (again): own the 1 s cadence. Decided HERE, at
    // the tail of every tick, so any entry point (App mount, an arm press)
    // heals a stopped loop — a timer armed after the previous start call
    // still gets watched.
    handle = setInterval(() => tick(Date.now()), 1000)
  }
}

/**
 * Run one scan now (idempotent with a running loop). The 1 s interval is
 * started BY tick() itself when armed timers exist — callers may run before
 * the timer they are arming is added to the store (the arm presses call
 * this before `ui.addTimer`), so starting the loop here would be too early.
 */
export function ensureTimerAlertPolling(): void {
  if (handle !== undefined) return
  // Seed immediately: timers already expired at start never fire.
  tick(Date.now())
}

/**
 * One scan over the persisted timer state at wall-clock `now`. Exported
 * for the unit suite (which drives it with controlled times instead of a
 * real interval) — production code goes through `ensureTimerAlertPolling`.
 */
export function scanTimerCompletions(now: number): void {
  tick(now)
}

/** Stop the 1 s loop (also the unit suite's afterEach cleanup). */
export function stopTimerAlertHost(): void {
  if (handle !== undefined) {
    clearInterval(handle)
    handle = undefined
  }
}
