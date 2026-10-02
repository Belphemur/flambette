import { describe, expect, test } from 'bun:test'

import { getTimerHints, hintForStep, suggestionFromHint, type TimerHint } from './timerSuggest'

/**
 * The runtime lib is a PURE LOOKUP over the build-time sidecar
 * (`<variantId>.timer.json`, ADR-0041 §3). The network seam is mocked:
 * these cases pin the lookup contract, the on-demand fetch and the
 * 404-is-empty behaviour — never a regex over authored text, which now
 * lives only in `scripts/extract_timer_hints.py`.
 */
const fixture: Record<number, TimerHint[]> = {
  5264: [
    { step: 0, seconds: 900, label: 'Step 1', range: [900, 1080] },
    { step: 6, seconds: 120, label: 'Shrimp', range: [120, 180] },
  ],
  13461: [{ step: 3, seconds: 300, label: 'Step 4' }],
}

const realFetch = globalThis.fetch
let fetchCalls: string[] = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  fetchCalls.push(url)
  const m = /recipes\/(\d+)\.timer\.json$/.exec(url)
  if (!m) throw new Error('unexpected url')
  const hints = fixture[Number(m[1])]
  if (!hints) return new Response(null, { status: 404 })
  return new Response(JSON.stringify({ steps: hints }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

describe('getTimerHints (per-recipe sidecar, on demand)', () => {
  test('fetches only the active variant and returns its steps', async () => {
    fetchCalls = []
    const hints = await getTimerHints(5264)
    expect(hints).toHaveLength(2)
    expect(fetchCalls).toEqual([expect.stringContaining('recipes/5264.timer.json')])
  })

  test('is cached per session — a second read does not re-fetch', async () => {
    fetchCalls = []
    await getTimerHints(5264)
    await getTimerHints(5264)
    expect(fetchCalls).toHaveLength(0)
  })

  test('a missing sidecar is an EMPTY hint list, not an error', async () => {
    fetchCalls = []
    const hints = await getTimerHints(999999)
    expect(hints).toEqual([])
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('hintForStep (lookup by view)', () => {
  test('finds the hint for the leader step', () => {
    const hint = hintForStep(fixture[5264]!, [0])
    expect(hint?.seconds).toBe(900)
  })

  test('a Meanwhile pair is ONE view — the paired step is tried too', () => {
    const hint = hintForStep(fixture[5264]!, [5, 6])
    expect(hint?.label).toBe('Shrimp')
  })

  test('no authored duration for this view → null, never invented', () => {
    expect(hintForStep(fixture[5264]!, [1])).toBeNull()
    expect(hintForStep([], [0])).toBeNull()
  })
})

describe('suggestionFromHint (confirm pre-fill)', () => {
  test('the lower bound is what is offered, and the range is disclosed', () => {
    const s = suggestionFromHint({ step: 0, seconds: 900, label: 'Step 1', range: [900, 1080] })
    expect(s.minutes).toBe(15)
    expect(s.seconds).toBe(900)
    expect(s.label).toBe('Step 1 (of 15–18)')
  })

  test('a label that fits without the range keeps the bare food name', () => {
    const s = suggestionFromHint({ step: 6, seconds: 120, label: 'Shrimp', range: [120, 180] })
    expect(s.label).toBe('Shrimp (of 2–3)')
  })

  test('a range too wide for the chip budget stays in the minutes text only', () => {
    const s = suggestionFromHint({
      step: 0,
      seconds: 900,
      label: 'A very long marinade name indeed',
      range: [900, 1080],
    })
    expect(s.label).toBe('A very long marinade name indeed')
    expect(s.range).toBe('15–18')
  })

  test('fractional minutes render with one decimal', () => {
    const s = suggestionFromHint({ step: 0, seconds: 90, label: 'Sauce' })
    expect(s.minutes).toBe(1.5)
    expect(s.label).toBe('Sauce')
  })

  test('a missing label falls back to the generic "Step" chip', () => {
    const s = suggestionFromHint({ step: 2, seconds: 300 })
    expect(s.label).toBe('Step')
    expect(s.minutes).toBe(5)
  })
})
