import { describe, expect, test } from 'bun:test'
import { hasUsedApp } from './usedApp'

/**
 * ADR-0096: the returning-user decision is derived from three signals —
 * a non-empty plan, a live room, or a saved household room code — and is
 * a pure function of exactly those signals. It must be self-healing (a
 * cleared device is new again) and backup-faithful (a restored archive
 * reproduces every signal), so the table pins every meaningful
 * combination rather than a single happy path.
 */
describe('hasUsedApp', () => {
  test('a plan with at least one entry is returning', () => {
    expect(hasUsedApp(1, false, '')).toBe(true)
    expect(hasUsedApp(3, false, '')).toBe(true)
  })

  test('a live room makes the device returning regardless of other state', () => {
    // A device standing in a room has used the app, even with no plan and
    // no saved household room (e.g. a Plan-tab room that never adopted).
    expect(hasUsedApp(0, true, '')).toBe(true)
  })

  test('a saved household room code is returning', () => {
    // The household setting is the persistent signal ADR-0096 Decision 1
    // calls out: it survives a session resume and covers a room the device
    // has not yet re-joined.
    expect(hasUsedApp(0, false, 'quartz-lantern-otter')).toBe(true)
  })

  test('any single signal is sufficient', () => {
    expect(hasUsedApp(1, false, '')).toBe(true)
    expect(hasUsedApp(0, true, '')).toBe(true)
    expect(hasUsedApp(0, false, 'amber-falcon-lantern')).toBe(true)
  })

  test('all signals must be absent for a brand-new device', () => {
    expect(hasUsedApp(0, false, '')).toBe(false)
  })

  test('an empty plan array is the same as no plan', () => {
    // The plan store's default is an empty array — length 0 — and that
    // must NOT count as use. Only a populated plan crosses the threshold.
    expect(hasUsedApp(0, false, '')).toBe(false)
  })

  test('a resumable session-only room code is returning', () => {
    // ADR-0096: the root guard reads a room code saved to session storage
    // by a previous page load BEFORE resume() runs, so a device that
    // holds only a session-only room (no plan, no persisted household
    // room, not yet live) lands on /recipes, not the hero.
    expect(hasUsedApp(0, false, '', 'quartz-lantern-otter')).toBe(true)
  })

  test('an absent resumable code is not by itself a returning signal', () => {
    expect(hasUsedApp(0, false, '', '')).toBe(false)
  })
})
