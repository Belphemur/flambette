import { describe, expect, test } from 'bun:test'
import {
  CHIME_TONES_HZ,
  TIMER_VIBRATE_PATTERN,
  chimeTonesForOrdinal,
  createTimerAlerts,
  type ChimeContext,
} from './timerAlert'
import { MAX_CONCURRENT_TIMERS } from './stepTimer'

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

describe('per-timer pitch (ADR-0093)', () => {
  test("ordinal 0 is today's A5→D6 exactly", () => {
    expect(chimeTonesForOrdinal(0)).toEqual([CHIME_TONES_HZ[0], CHIME_TONES_HZ[1]])
  })

  test('each ordinal transposes BOTH tones and preserves the rising interval', () => {
    for (const ordinal of [0, 1, 2, 3]) {
      const { ctx, oscillators } = stubContext()
      const alerts = createTimerAlerts(() => ({ sound: true, vibrate: false }), () => ctx)
      alerts.unlock()
      alerts.fire(ordinal)
      const [lo, hi] = chimeTonesForOrdinal(ordinal)
      expect(oscillators.map((o) => o.freq)[0]).toBeCloseTo(lo)
      expect(oscillators.map((o) => o.freq)[1]).toBeCloseTo(hi)
      // The SAME offset shifts both tones: the pair's ratio is unchanged.
      expect(hi / lo).toBeCloseTo(CHIME_TONES_HZ[1] / CHIME_TONES_HZ[0])
    }
  })

  test('the semitone offsets are 0/+2/+4/+7 (freq = base * 2 ** (st / 12))', () => {
    const semitonesAbove = (freq: number, base: number): number => 12 * Math.log2(freq / base)
    const [lo0] = chimeTonesForOrdinal(0)
    expect(semitonesAbove(chimeTonesForOrdinal(0)[0], lo0)).toBeCloseTo(0)
    expect(semitonesAbove(chimeTonesForOrdinal(1)[0], lo0)).toBeCloseTo(2)
    expect(semitonesAbove(chimeTonesForOrdinal(2)[0], lo0)).toBeCloseTo(4)
    expect(semitonesAbove(chimeTonesForOrdinal(3)[0], lo0)).toBeCloseTo(7)
    // …and every high tone carries the same offset as its own low tone.
    for (const ordinal of [0, 1, 2, 3]) {
      const [lo, hi] = chimeTonesForOrdinal(ordinal)
      expect(semitonesAbove(hi, lo)).toBeCloseTo(12 * Math.log2(CHIME_TONES_HZ[1] / CHIME_TONES_HZ[0]))
    }
  })

  test('ordinals are bounded by MAX_CONCURRENT_TIMERS — beyond the cap clamps to the last offset', () => {
    expect(chimeTonesForOrdinal(MAX_CONCURRENT_TIMERS)).toEqual(chimeTonesForOrdinal(MAX_CONCURRENT_TIMERS - 1))
    expect(chimeTonesForOrdinal(99)).toEqual(chimeTonesForOrdinal(3))
    // A nonsense ordinal never crashes or drops below the base pitch.
    expect(chimeTonesForOrdinal(-1)).toEqual(chimeTonesForOrdinal(0))
  })

  test('sound OFF stays silent for any ordinal', () => {
    const { ctx, oscillators } = stubContext()
    const alerts = createTimerAlerts(() => ({ sound: false, vibrate: false }), () => ctx)
    alerts.unlock()
    alerts.fire(3)
    expect(oscillators).toEqual([])
  })
})
