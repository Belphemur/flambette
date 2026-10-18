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
 * ADR-0093 turns the one-shot alert into a RECURRING, ESCALATING alarm: a
 * fired timer alerts in ROUNDS (each round = chime + vibration, each
 * channel honoring its toggle read live) and the pause AFTER a round
 * grows — 2 s, 4 s, 8 s, 16 s, then a 30 s cap — until the user stops
 * the timer. User action is OBSERVED, never hooked: a key whose countdown
 * is live again (Restart/Resume) or has vanished (Cancel/Clear) drops out
 * of the alarming set on the next tick, exactly like the armed/alerted
 * union cleanup. The ONE interval stays the scheduler: the tick checks
 * which rounds are due, and the loop stays alive while ANY timer is
 * alarming even though nothing is counting. A timer already expired when
 * first seen never alarms (the seeding rule above).
 *
 * Three guards keep the alarm honest (review hardening, ADR-0093 change
 * note 2026-10-19): the pitch ordinal is CAPTURED at round 1 (clearing a
 * lower-id timer never moves a ringing alarm to another voice); an alarm
 * is pinned to the record it was raised against (a backup restore that
 * re-creates the same ids drops the old alarm instead of inheriting its
 * rounds); and with BOTH channels dead (sound off, vibration off or the
 * API absent) the host never enters — or stays in — the alarming set, so
 * no invisible alarm can pin the interval forever. The alarming set is
 * mirrored reactively (`alarmingTimers`) for the shell's global stop
 * banner: ADR-0093's stop verbs live on the cooking strip, and a cook who
 * finished (or is on any other surface) must still be able to stop it.
 *
 * Autoplay discipline is unchanged: the AudioContext is created/resumed only
 * inside a user gesture (`unlockTimerAlertAudio`, called from the Start-timer
 * and Restart presses); a chime without a gesture degrades silently to the
 * announcement + vibration. Polling starts lazily and stops itself when no
 * timer is live and every expired one has been accounted for.
 */

import { ref } from 'vue'
import { useUiStore } from '../stores/ui'
import { remainingSeconds, type CookTimer } from './stepTimer'
import { createTimerAlerts, type TimerAlerts } from './timerAlert'

let engine: TimerAlerts | null = null
let handle: ReturnType<typeof setInterval> | undefined
/** Keys this session SAW counting down (armed) — only they may fire. */
const armed = new Set<string>()
/** Keys that have fired (or were seeded as already-expired). */
const alerted = new Set<string>()

/* ---------- Recurring escalating alarm (ADR-0093) ---------- */

/** Pause AFTER a round, indexed by the round just fired (0-based): grows
 * 2 s → 4 → 8 → 16, then the 30 s cap — an unattended phone escalates
 * instead of buzzing nonstop, but never falls silent on its own. */
export const ALARM_ROUND_PAUSE_SECONDS: readonly number[] = [2, 4, 8, 16, 30]

function pauseAfterRound(round: number): number {
  return ALARM_ROUND_PAUSE_SECONDS[Math.min(round, ALARM_ROUND_PAUSE_SECONDS.length - 1)]
}

/** Per-key alarming state: the round just fired (0-based), its stamp, the
 *  pitch ordinal CAPTURED AT ROUND 1 (the strip's membership can change —
 *  clearing a lower-id timer must never move a ringing alarm to another
 *  pitch, ADR-0093 per-timer pitch), and the identity of the record the
 *  alarm was raised against (a backup restore that re-creates the same
 *  ids must not inherit the previous timer's rounds). */
interface AlarmState {
  round: number
  lastFire: number
  ordinal: number
  src: string
}
/** Keys currently alarming — a fired timer rings UNTIL THE USER STOPS IT. */
const alarming = new Map<string, AlarmState>()

/**
 * The identity of a timer RECORD the alarm is pinned to: the run segment
 * (remaining/running/startedAt) plus the armed total. A backup restore
 * that re-creates the same `variantId:timerId` produces a different
 * fingerprint — the old alarm is NOT the restored record's alarm and is
 * dropped (the restored record re-enters the normal rules, so an
 * already-expired restore is seeded silently). A rename keeps the alarm
 * (a label is not a stop); a Pause rewrites the segment and IS a stop
 * (ADR-0093 §1 lists Pause among the stop verbs).
 */
function srcOf(t: CookTimer): string {
  return `${t.remaining}|${t.running}|${t.startedAt ?? ''}|${t.total ?? ''}`
}

/**
 * Whether ANY alarm channel can produce output right now (each toggle is
 * read live): sound is on, or vibration is on AND the API exists. With
 * both channels dead an alarm would be an invisible, inaudible interval
 * that never stops — so the host never enters (or stays in) the alarming
 * set; the toggle flip IS the user stop. The banner (below) is a display
 * of the alarm, not a channel: it never keeps a dead-alarm loop alive.
 */
function channelsLive(ui: ReturnType<typeof useUiStore>): boolean {
  if (ui.timerAlertSound) return true
  if (!ui.timerAlertVibrate) return false
  const v = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { vibrate?: unknown }).vibrate
  return typeof v === 'function'
}

/** One alarming timer as the shell's banner sees it. */
export interface AlarmingTimer {
  variantId: number
  timerId: number
  label: string
}

/**
 * Reactive mirror of the alarming set, for the app shell's global
 * "timer is ringing — Stop" banner (ADR-0093 stop reachability): the
 * stop verbs live on the cooking strip, and a cook who finished (or is
 * anywhere else) must still be able to stop the alarm. Reassigned only
 * when the CONTENT changes, so the 1 s tick never churns reactivity.
 */
export const alarmingTimers = ref<AlarmingTimer[]>([])

function syncAlarmingSnapshot(ui: ReturnType<typeof useUiStore>): void {
  const next: AlarmingTimer[] = []
  for (const key of alarming.keys()) {
    const [variantId, timerId] = key.split(':').map(Number)
    const label = ui.stepTimers[variantId]?.[timerId]?.label ?? 'Timer'
    next.push({ variantId, timerId, label })
  }
  const prev = alarmingTimers.value
  if (
    prev.length !== next.length ||
    prev.some((p, i) => p.variantId !== next[i].variantId || p.timerId !== next[i].timerId || p.label !== next[i].label)
  ) {
    alarmingTimers.value = next
  }
}

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
    // The strip's order (ui.timers semantics): oldest id first. The
    // chime's ordinal comes from THIS list at fire time (ADR-0093 pitch).
    const ordered = (Object.values(timers ?? {}) as (CookTimer | undefined)[])
      .filter((t): t is CookTimer => !!t)
      .sort((a, b) => a.id - b.id)
    for (const t of ordered) {
      const key = keyOf(variantId, t.id)
      seen.add(key)
      const left = remainingSeconds(t, now)
      if (left > 0) {
        // Counting (again): forget any past alert AND any running alarm —
        // a Restart/Resume observed here is the user stopping the alarm,
        // and the timer's NEXT expiry starts a fresh round 1.
        armed.add(key)
        alerted.delete(key)
        alarming.delete(key)
        live = true
      } else if (armed.has(key) && !alerted.has(key)) {
        // This session watched it reach zero: round 1 fires now, and the
        // timer stays in the alarming set until the user stops it.
        alerted.add(key)
        if (channelsLive(ui)) {
          // A dead-alarm loop (both channels off/absent) is a permanent
          // 1 s interval that outputs nothing — never enter the set.
          alarming.set(key, { round: 0, lastFire: now, ordinal: ordered.indexOf(t), src: srcOf(t) })
          ensureEngine().fire(ordered.indexOf(t))
        }
      } else if (alarming.has(key)) {
        // Still alarming: fire the next round when its grown pause is due.
        const state = alarming.get(key)! // eslint-disable-line @typescript-eslint/no-non-null-assertion
        if (srcOf(t) !== state.src) {
          // The record under this key was REPLACED (a backup restore
          // re-created the same ids, or a Pause at zero) — the old alarm
          // is not this record's alarm: drop it. The record itself
          // re-enters the normal rules, so an already-expired restore is
          // seeded silently, never inherited.
          alarming.delete(key)
        } else if (!channelsLive(ui)) {
          // The user turned the last channel off mid-alarm: that IS a
          // user stop (ADR-0093 — only the user stops the alarm).
          alarming.delete(key)
        } else if (now - state.lastFire >= pauseAfterRound(state.round) * 1000) {
          alarming.set(key, { round: state.round + 1, lastFire: now, ordinal: state.ordinal, src: state.src })
          // The pitch is the ordinal captured at round 1 — the strip's
          // membership may have changed since (a lower-id timer cleared),
          // and a ringing alarm must keep its voice (ADR-0093 pitch).
          ensureEngine().fire(state.ordinal)
        }
      } else {
        // Already expired when first seen (app boot, or a timer that
        // expired while the interval was stopped): seed silently.
        alerted.add(key)
      }
    }
  }
  // Forget every key of THIS recipe set that vanished while we were not
  // looking (a timer cleared mid-countdown or mid-alarm, a backup that
  // rewrote the map): iterate the UNION — a key that is armed-but-never-
  // alerted is exactly the leak an `alerted`-only walk misses, and a
  // stale armed key would fire a spurious alert if a later restore
  // re-created that id already expired (the seeding rule would never see
  // it count). A vanished alarming key is a Cancel/Clear: the alarm stops.
  for (const key of [...alerted, ...armed, ...alarming.keys()]) {
    if (!seen.has(key)) {
      alerted.delete(key)
      armed.delete(key)
      alarming.delete(key)
    }
  }
  syncAlarmingSnapshot(ui)
  if (!live && alerted.size === seen.size && alarming.size === 0) {
    stopTimerAlertHost()
  } else if ((armed.size > 0 || alarming.size > 0) && handle === undefined) {
    // Something is counting (again) — or still alarming with nothing
    // counting (ADR-0093: the alarm outlives the countdown until the user
    // stops it). Decided HERE, at the tail of every tick, so any entry
    // point (App mount, an arm press) heals a stopped loop — a timer
    // armed after the previous start call still gets watched.
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

/** Whether the 1 s loop is running (unit-suite seam: the loop's OWN stop
 *  conditions — nothing live, everything accounted for, nothing alarming —
 *  are asserted against this, not against wall-clock timing). */
export function timerAlertLoopRunning(): boolean {
  return handle !== undefined
}

/**
 * Clear ALL host state (armed/alerted/alarming + the loop). Unit-suite
 * seam only — production never calls this; the module state is meant to
 * outlive a single cook session.
 */
export function resetTimerAlertHostForTests(): void {
  stopTimerAlertHost()
  armed.clear()
  alerted.clear()
  alarming.clear()
  alarmingTimers.value = []
}
