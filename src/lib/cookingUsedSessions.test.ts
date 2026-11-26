import { describe, expect, test } from 'bun:test'
import {
  COOKING_USED_TTL_MS,
  freshCookingUsedKeys,
  isFreshCookingSession,
  type CookingUsedSessions,
} from './cookingUsedSessions'

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const session = (startedAt: number, usedKeys = ['2:0:lemon']) => ({ startedAt, usedKeys })

describe('ADR-0103 cooking used-set read-time TTL', () => {
  const sessions: CookingUsedSessions = {
    5132: session(NOW - 60_000),
    5995: session(NOW - COOKING_USED_TTL_MS - 1),
  }

  test('a live session returns its keys', () => {
    expect(freshCookingUsedKeys(sessions, 5132, NOW)).toEqual(['2:0:lemon'])
  })

  test('a session at exactly 24h is dead', () => {
    const atCap: CookingUsedSessions = { 1: session(NOW - COOKING_USED_TTL_MS) }
    expect(freshCookingUsedKeys(atCap, 1, NOW)).toEqual([])
    expect(isFreshCookingSession(atCap[1], NOW)).toBe(false)
  })

  test('an older session and an unknown recipe start clean', () => {
    expect(freshCookingUsedKeys(sessions, 5995, NOW)).toEqual([])
    expect(freshCookingUsedKeys(sessions, 7777, NOW)).toEqual([])
  })

  test('a malformed persisted entry is never trusted', () => {
    const bad: CookingUsedSessions = {
      1: { startedAt: Number.NaN, usedKeys: ['x'] },
      2: { startedAt: NOW, usedKeys: 'nope' as unknown as string[] },
      3: { startedAt: NOW + 60_000, usedKeys: ['x'] },
    }
    for (const id of [1, 2, 3]) expect(freshCookingUsedKeys(bad, id, NOW)).toEqual([])
  })

  test('the TTL is exactly 24 hours', () => {
    expect(COOKING_USED_TTL_MS).toBe(86_400_000)
  })
})
