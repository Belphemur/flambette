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
 */

/** The completion buzz: three short pulses with gaps, ends on a long one. */
export const TIMER_VIBRATE_PATTERN: number[] = [200, 140, 200, 140, 400]

/** The two-tone chime's pitches (Hz): A5 → D6, a rising "done". */
export const CHIME_TONES_HZ: readonly [number, number] = [880, 1174.66]

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

/** Two rising sine tones with a click-free gain envelope. */
function playTwoTone(ctx: ChimeContext): void {
  const t0 = ctx.currentTime
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
  tone(CHIME_TONES_HZ[0], 0, 0.18)
  tone(CHIME_TONES_HZ[1], 0.22, 0.32)
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

  /** The chime: silent degradation when there is no runnable context. */
  function chime(): void {
    if (!getPrefs().sound) return
    if (!ctx || ctx.state !== 'running') return
    try {
      playTwoTone(ctx)
    } catch {
      // Never surface an audio failure to a cook holding a knife.
    }
  }

  /** Fire BOTH channels (each honours its own toggle). */
  function fire(): void {
    chime()
    vibrate()
  }

  return { unlock, fire, chime, vibrate }
}

export type TimerAlerts = ReturnType<typeof createTimerAlerts>
