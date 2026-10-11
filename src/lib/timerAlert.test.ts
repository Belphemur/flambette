import { describe, expect, test } from 'bun:test'
import {
  CHIME_TONES_HZ,
  TIMER_VIBRATE_PATTERN,
  createTimerAlerts,
  type ChimeContext,
} from './timerAlert'

/** A stub AudioContext that records the chime's graph operations. */
function stubContext(state = 'running') {
  const oscillators: { freq: number; starts: number[]; stops: number[] }[] = []
  const gainRamps: number[] = []
  const ctx: ChimeContext = {
    currentTime: 5,
    state,
    resume: async () => {},
    destination: {} as AudioNode,
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: { value: 0, setValueAtTime: () => {} },
        connect: () => osc,
        start: (t: number) => oscRec.starts.push(t),
        stop: (t: number) => oscRec.stops.push(t),
      }
      const oscRec = { freq: 0, starts: [] as number[], stops: [] as number[] }
      Object.defineProperty(osc.frequency, 'value', {
        get: () => oscRec.freq,
        set: (v: number) => {
          oscRec.freq = v
        },
      })
      oscillators.push(oscRec)
      return osc as unknown as OscillatorNode
    },
    createGain: () => {
      const gain = {
        gain: {
          setValueAtTime: (v: number) => void v,
          linearRampToValueAtTime: (v: number) => gainRamps.push(v),
        },
        connect: () => gain,
      }
      return gain as unknown as GainNode
    },
  }
  return { ctx, oscillators, gainRamps }
}

describe('timer alerts (ADR-0081 amendment)', () => {
  test('the chime plays two rising tones through a running context', () => {
    const { ctx, oscillators } = stubContext()
    const alerts = createTimerAlerts(() => ({ sound: true, vibrate: true }), () => ctx)
    alerts.unlock()
    alerts.fire()
    expect(oscillators.map((o) => o.freq)).toEqual([CHIME_TONES_HZ[0], CHIME_TONES_HZ[1]])
    // Rising: the second tone is pitched above the first.
    expect(CHIME_TONES_HZ[1]).toBeGreaterThan(CHIME_TONES_HZ[0])
  })

  test('sound OFF → no chime, vibration ON → still buzzes', () => {
    const { ctx, oscillators } = stubContext()
    const alerts = createTimerAlerts(() => ({ sound: false, vibrate: true }), () => ctx)
    alerts.unlock()
    alerts.fire()
    expect(oscillators).toEqual([])
  })

  test('vibration OFF → navigator.vibrate is never called', () => {
    const calls: unknown[] = []
    const navigatorAny = navigator as Navigator & { vibrate?: unknown }
    const original = navigatorAny.vibrate
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        calls.push(pattern)
        return true
      },
    })
    try {
      const alerts = createTimerAlerts(() => ({ sound: false, vibrate: false }))
      alerts.fire()
      expect(calls).toEqual([])
    } finally {
      if (original === undefined) delete navigatorAny.vibrate
      else Object.defineProperty(navigator, 'vibrate', { configurable: true, value: original })
    }
  })

  test('vibration ON + API present → the pattern is passed (feature-detected, not assumed)', () => {
    const calls: unknown[] = []
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        calls.push(pattern)
        return true
      },
    })
    try {
      const alerts = createTimerAlerts(() => ({ sound: false, vibrate: true }))
      alerts.fire()
      expect(calls).toEqual([TIMER_VIBRATE_PATTERN])
    } finally {
      delete (navigator as { vibrate?: unknown }).vibrate
    }
  })

  test('no runnable context (suspended, never unlocked) → silent degradation, never an error', () => {
    const { ctx, oscillators } = stubContext('suspended')
    const alerts = createTimerAlerts(() => ({ sound: true, vibrate: false }), () => ctx)
    // unlock() never ran: the chime path must no-op, not throw.
    alerts.fire()
    expect(oscillators).toEqual([])
  })

  test('a factory that throws is absorbed — unlock stays gesture-safe', () => {
    const alerts = createTimerAlerts(
      () => ({ sound: true, vibrate: false }),
      () => {
        throw new Error('no audio device')
      },
    )
    expect(() => alerts.unlock()).not.toThrow()
    expect(() => alerts.fire()).not.toThrow()
  })

  test('prefs are read at FIRE time, never captured at creation', () => {
    const { ctx, oscillators } = stubContext()
    let sound = false
    const alerts = createTimerAlerts(() => ({ sound, vibrate: false }), () => ctx)
    alerts.unlock()
    alerts.fire()
    expect(oscillators).toEqual([])
    sound = true // the toggle flipped mid-cook
    alerts.fire()
    expect(oscillators).toHaveLength(2)
  })
})
