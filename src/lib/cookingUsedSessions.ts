/**
 * ADR-0103 owner ruling 2026-11-26: cooking mode REMEMBERS its used-set
 * for the session's lifetime, capped at 24 hours. The state lives in the
 * ui store's persisted slice as one entry per recipe id; this module owns
 * the read-time TTL predicate so no clock/sweeper ever runs in background.
 * Detail stays fully ephemeral (a plain component ref) and never calls in.
 */

export const COOKING_USED_TTL_MS = 24 * 60 * 60 * 1000

export interface CookingUsedSession {
  /** When THIS cooking session was opened (ms since epoch). */
  startedAt: number
  /** Canonical step-row keys (`step:line:nameKey`), never rendered amounts. */
  usedKeys: string[]
}

export type CookingUsedSessions = Record<number, CookingUsedSession>

/** Malformed persisted data is treated as a dead session, never trusted. */
export function isFreshCookingSession(
  session: CookingUsedSession | undefined,
  now: number = Date.now(),
): session is CookingUsedSession {
  if (!session || !Array.isArray(session.usedKeys)) return false
  const startedAt = session.startedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return false
  const age = now - startedAt
  // A future stamp is not an honest start time; treat it as stale rather
  // than letting a bad clock keep a session alive indefinitely.
  return age >= 0 && age < COOKING_USED_TTL_MS
}

/** The used keys of a LIVE session, or an empty set (read-time expiry). */
export function freshCookingUsedKeys(
  sessions: CookingUsedSessions | undefined,
  recipeId: number,
  now: number = Date.now(),
): string[] {
  return isFreshCookingSession(sessions?.[recipeId], now) ? [...sessions![recipeId].usedKeys] : []
}
