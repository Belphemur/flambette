/**
 * Timer completion alerts (ADR-0081 timer-alert amendment).
 *
 * When a step timer reaches zero the device alerts per the household's
 * settings: a short synthesized chime (Web Audio, generated at RUNTIME —
 * no audio asset, no new dependency) and/or a vibration pattern
 * (`navigator.vibrate`, feature-detected, a graceful no-op where the API
 * is missing). The ADR-0020 polite live-region announcement STAYS — the
 * alert ADDS the audible + haptic channels to it, because a cook with
 * hands in the sink (or an oven roaring) may neither see nor hear a
 * silent countdown.
 *
 * Autoplay discipline: browsers only allow audio after a user gesture, so
 * the AudioContext is created/resumed lazily at the Start-timer press
 * (`unlock`) and the completion chime plays through it. No gesture ever
 * happened (or the context cannot start) → the chime degrades to the
 * announcement + vibration SILENTLY. Never an error surfaced.
 *
 * The settings themselves are DEVICE-LOCAL (ADR-0037's defaultServings
 * reasoning, recorded in the ADR so nobody "fixes" this into the room
 * payload): sound and vibration are per-device capabilities, and one
 * household member must not configure another phone's alerts.
 *
 * ADR-0093 amends the one-shot alert into a RECURRING, ESCALATING alarm
 * driven by the host (rounds + growing pauses — see timerAlertHost.ts)
 * and pitches the chime per timer: `chime`/`fire` take the timer's
 * 0-based ORDINAL among its recipe's timers (see the per-timer pitch
 * section below); the engine itself stays stateless about rounds.
 *
 * ADR-0104 adds a THIRD channel — a visual shake owned by the host/UI,
 * not by this engine. Sound and vibration therefore remain the only
 * channels `fire` drives; the engine only has to make its own channels
 * as reliable as the browser allows (chime recovery at FIRE time).
 */

import { MAX_CONCURRENT_TIMERS } from './stepTimer'

/** The completion buzz: three short pulses with gaps, ends on a long one. */
export const TIMER_VIBRATE_PATTERN: number[] = [200, 140, 200, 140, 400]

/** The two-tone chime's pitches (Hz): A5 → D6, a rising "done". */
export const CHIME_TONES_HZ: readonly [number, number] = [880, 1174.66]

/* ---------- Per-timer pitch (ADR-0093) ----------
 *
 * With ADR-0041's concurrent named timers, the oven and the rice expired
 * to identical tones — the cook could not tell WHICH work finished by
 * ear. Each timer's ORDINAL among its recipe's timers (the strip's
 * order, oldest id first) transposes BOTH tones of the pair by the same
 * semitone offset so the rising interval is preserved:
 * `freq = base * 2 ** (semitones / 12)`. Offsets 0/+2/+4/+7 for timers
 * 1–4; the list is bounded by `MAX_CONCURRENT_TIMERS` so the two stay in
 * lockstep if the cap ever changes, and ordinal 0 is today's A5→D6
 * exactly.
 */

/** Semitone offset for the timer at ordinal 0, 1, 2, 3… (clamped at the end). */
const CHIME_SEMITONES: readonly number[] = [0, 2, 4, 7].slice(0, MAX_CONCURRENT_TIMERS)

/**
 * The chime pair for a timer at 0-based `ordinal` among its recipe's
 * timers. Out-of-range ordinals clamp to the last offset (the host
 * already bounds by `MAX_CONCURRENT_TIMERS`; this is a second net).
 */
export function chimeTonesForOrdinal(ordinal: number): readonly [number, number] {
  const i = Math.min(Math.max(Math.trunc(ordinal), 0), CHIME_SEMITONES.length - 1)
  const st = CHIME_SEMITONES[i]
  const shift = (base: number): number => base * 2 ** (st / 12)
  return [shift(CHIME_TONES_HZ[0]), shift(CHIME_TONES_HZ[1])]
}

export interface TimerAlertPrefs {
  sound: boolean
  vibrate: boolean
}

type VibrateFn = (pattern: number | number[]) => boolean

/** Minimal structural view of the AudioContext the chime plays through. */
export interface ChimeContext {
  currentTime: number
  state: string
  resume(): Promise<void>
  destination: AudioNode
  createOscillator(): OscillatorNode
  createGain(): GainNode
}

export type AudioContextFactory = () => ChimeContext | null

/** Two rising sine tones with a click-free gain envelope, transposed by
 * the timer's ordinal semitone offset (ADR-0093 per-timer pitch). */
function playTwoTone(ctx: ChimeContext, ordinal = 0): void {
  const t0 = ctx.currentTime
  const [lo, hi] = chimeTonesForOrdinal(ordinal)
  const tone = (freq: number, start: number, dur: number) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t0 + start)
    gain.gain.linearRampToValueAtTime(0.2, t0 + start + 0.02)
    gain.gain.setValueAtTime(0.2, t0 + start + dur - 0.04)
    gain.gain.linearRampToValueAtTime(0, t0 + start + dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0 + start)
    osc.stop(t0 + start + dur)
  }
  tone(lo, 0, 0.18)
  tone(hi, 0.22, 0.32)
}

/**
 * One alert engine per cooking session. `getPrefs` is read at EVERY call,
 * never captured — a toggle flipped mid-cook governs the very next alert.
 */
export function createTimerAlerts(
  getPrefs: () => TimerAlertPrefs,
  audioFactory?: AudioContextFactory,
) {
  let ctx: ChimeContext | null = null

  /**
   * Create/resume the AudioContext inside the Start-timer gesture. Called
   * on every arm — resuming an already-running context is a no-op, so
   * repeated calls are free. Never throws.
   */
  function unlock(): void {
    try {
      if (!ctx) {
        if (audioFactory) {
          // An injected factory is a plain callable (tests).
          ctx = audioFactory()
        } else {
          // WebIDL constructors THROW without `new` — the native path
          // must be a real construction, never a bare call (qodo: the
          // chime would silently never play in a real browser).
          const g = globalThis as {
            AudioContext?: new () => ChimeContext
            webkitAudioContext?: new () => ChimeContext
          }
          const Native = g.AudioContext ?? g.webkitAudioContext
          if (!Native) return
          ctx = new Native()
        }
      }
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
    } catch {
      // Audio unavailable: the alert degrades to announcement + vibration.
      ctx = null
    }
  }

  /** Feature-detected vibration; a no-op where the API is absent. */
  function vibrate(): void {
    if (!getPrefs().vibrate) return
    const v = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { vibrate?: VibrateFn }).vibrate
    if (typeof v !== 'function') return
    try {
      v.call(navigator, TIMER_VIBRATE_PATTERN)
    } catch {
      // Some engines throw on malformed input; ours is a plain number
      // array, but a silent no-op beats a crash either way.
    }
  }

  /** The chime: silent degradation when there is no runnable context.
   * `ordinal` is the timer's 0-based position among its recipe's timers
   * (ADR-0093 per-timer pitch); the default 0 is the original A5→D6.
   *
   * ADR-0104 (Brave/Android): a context unlocked inside the arm gesture
   * can still be `suspended` at fire time — Shields/autoplay policies
   * swallow the unlock resume. Retry `resume()` HERE, when the alarm is
   * actually firing, and play as soon as the context reaches `running`.
   * A rejected/pending resume degrades silently to the other channels;
   * the visual floor lives in the host/UI, never in this engine. */
  function chime(ordinal = 0, isCurrent?: () => boolean): void {
    // The device-local toggle is read at CALL time (every round) and AGAIN
    // inside the resume continuation: Brave can leave `resume()` pending
    // until user activation, and a cook may switch sound off (or stop the
    // alarm) while that promise is in flight. `isCurrent` is the host's
    // generation check — the engine stays stateless about rounds and does
    // not know which timer fired.
    if (!getPrefs().sound) return
    const active = ctx
    if (!active) return
    const playIfRunning = (): void => {
      try {
        if (active.state !== 'running') return
        if (!getPrefs().sound) return
        if (isCurrent && !isCurrent()) return
        playTwoTone(active, ordinal)
      } catch {
        // Never surface an audio failure to a cook holding a knife.
      }
    }
    if (active.state === 'running') {
      playIfRunning()
      return
    }
    try {
      // A resume promise can reject (blocked autoplay, closed context) —
      // BOTH outcomes are a silent no-op, never an unhandled rejection.
      void Promise.resolve(active.resume()).then(playIfRunning, () => {})
    } catch {
      // A synchronous throw (a stub, or a broken native binding) is the
      // same silent degradation path.
    }
  }

  /** Fire BOTH engine channels (each honours its own toggle). The visual
   *  shake channel (ADR-0104) is owned by the host/UI and cannot be off. */
  function fire(ordinal = 0, isCurrent?: () => boolean): void {
    chime(ordinal, isCurrent)
    vibrate()
  }

  return { unlock, fire, chime, vibrate }
}

export type TimerAlerts = ReturnType<typeof createTimerAlerts>
