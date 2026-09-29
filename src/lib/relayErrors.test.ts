import { describe, expect, test } from 'bun:test'
import { describeRelayError } from './relayErrors'

/**
 * The decision the room store applies to a relay `error` frame:
 * stop for good (retry === false), keep the backoff running
 * (retry === true), or handle it in the store (retry === null).
 * ADR-0026 — most important is that an expired room does NOT loop.
 */
describe('describeRelayError', () => {
  test('room_expired stops the client for good, with an honest message', () => {
    const outcome = describeRelayError('room_expired')
    expect(outcome.retry).toBe(false)
    expect(outcome.message).toContain('expired')
  })

  test('not_found (older relay, or a dead code) is also terminal', () => {
    const outcome = describeRelayError('not_found')
    expect(outcome.retry).toBe(false)
    expect(outcome.message).toContain('not found')
  })

  test('rate_limited keeps retrying (the budget refills)', () => {
    expect(describeRelayError('rate_limited').retry).toBe(true)
  })

  test('frame-level rejections never tear the room down (F6)', () => {
    // Our own frames were refused — the room itself is alive, so the
    // store must do NOTHING (not even a reconnect, which would send
    // `leave` and, as the last peer, delete the live room).
    for (const code of ['bad_state', 'bad_json', 'unknown_type']) {
      const outcome = describeRelayError(code)
      expect(outcome.retry).toBe('ignore')
      expect(outcome.message).toBeNull()
    }
  })

  test('not_in_room is a real loss of the room, so it retries', () => {
    // Unlike a refused frame, the relay is saying this socket is not in
    // a room: re-join and re-seed.
    expect(describeRelayError('not_in_room')).toEqual({ message: null, retry: true })
  })

  test('code_taken is handed back to the store (it re-rolls)', () => {
    expect(describeRelayError('code_taken')).toEqual({ message: null, retry: null })
  })

  test('an unknown code surfaces and stops, never spins in connecting', () => {
    const outcome = describeRelayError('meteor_strike')
    expect(outcome.retry).toBe(false)
    expect(outcome.message).toBe('Room error — meteor_strike')
  })

  test('a missing code is reported as unknown, not a crash', () => {
    expect(describeRelayError(undefined).message).toBe('Room error — unknown')
  })
})
