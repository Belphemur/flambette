import { describe, expect, test } from 'bun:test'
import { PULL_CLEAR_THRESHOLD, PULL_SLOP, pullPhase, pullTranslate } from './pullToClear'

/**
 * ADR-0092's gesture math contracts: the resistance curve is monotone,
 * anchored, and saturating; the phase machine engages only past the
 * slop and arms exactly at the threshold.
 */

describe('pullTranslate (ADR-0092 resistance curve)', () => {
  test('zero and upward travel never translate', () => {
    expect(pullTranslate(0)).toBe(0)
    expect(pullTranslate(-40)).toBe(0)
  })

  test('the pull resists: translate is less than finger travel', () => {
    expect(pullTranslate(PULL_CLEAR_THRESHOLD)).toBeLessThan(PULL_CLEAR_THRESHOLD)
    expect(pullTranslate(16)).toBeLessThan(16)
  })

  test('the curve is monotone in finger travel', () => {
    let prev = 0
    for (let dy = 1; dy <= 400; dy += 7) {
      const t = pullTranslate(dy)
      expect(t).toBeGreaterThanOrEqual(prev)
      expect(t).toBeGreaterThan(0)
      prev = t
    }
  })

  test('the curve saturates at twice the threshold — content never runs away', () => {
    expect(pullTranslate(10_000)).toBeLessThanOrEqual(PULL_CLEAR_THRESHOLD * 2)
  })

  test('a short pull stays below the armed distance in translated pixels', () => {
    expect(pullTranslate(20)).toBeLessThan(PULL_CLEAR_THRESHOLD / 2)
  })
})

describe('pullPhase (ADR-0092 state machine)', () => {
  test('not engaged is idle, whatever the travel', () => {
    expect(pullPhase(200, false)).toBe('idle')
  })

  test('engaged but within the slop is idle (no indicator flash on a tap)', () => {
    expect(pullPhase(PULL_SLOP - 1, true)).toBe('idle')
    expect(pullPhase(0, true)).toBe('idle')
  })

  test('engaged past the slop but below the threshold is pull', () => {
    expect(pullPhase(PULL_SLOP, true)).toBe('pull')
    expect(pullPhase(PULL_CLEAR_THRESHOLD - 1, true)).toBe('pull')
  })

  test('engaged at the threshold is armed — release then clears', () => {
    expect(pullPhase(PULL_CLEAR_THRESHOLD, true)).toBe('armed')
    expect(pullPhase(PULL_CLEAR_THRESHOLD + 5, true)).toBe('armed')
  })

  test('engaged and pulled back below the threshold de-arms to pull', () => {
    expect(pullPhase(40, true)).toBe('pull')
  })
})
