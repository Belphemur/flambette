/**
 * Timestamp trust rules shared by the household-preference stores
 * (ADR-0031). Favourites and ratings both reconcile PER KEY by an
 * untrusted `updatedAt` — arriving from a room peer, a backup file or a
 * hand-edit — under per-key last-writer-wins, so they share one stamp
 * sanitizer instead of two drift-prone copies. A lib module, not a
 * store-to-store import: neither store may depend on the other.
 */

/** A timestamp must be a finite, non-negative number of ms. */
export function normalizeStamp(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * How far AHEAD of our own clock an inbound stamp may sit before we stop
 * trusting it. Clock skew between two phones on a LAN is seconds, not
 * hours — but a peer (or a hand-edited file) claiming a timestamp far in
 * the future would pin that record forever: every later, honest write
 * looks "older" and is discarded. Clamping keeps a skewed peer usable and
 * bounds the damage of a bogus one.
 */
export const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000

/** Clamp an untrusted stamp into "plausible" territory. */
export function clampStamp(stamp: number, now: number): number {
  return Math.min(stamp, now + MAX_FUTURE_SKEW_MS)
}

/**
 * The per-key last-writer-wins merge BOTH household-preference stores
 * reconcile room snapshots with (ADR-0031): a record lands only when it is
 * strictly NEWER than what we hold — an equal timestamp is not a new
 * opinion, so an echo/replay can never flap. Never a wholesale replace:
 * two peers editing different keys must not clobber each other. The
 * sanitize step stays per-store (each store validates its own shape);
 * this is only the merge loop.
 */
export function mergeLww<T extends { updatedAt: number }>(
  local: Record<string, T>,
  incoming: Record<string, T>,
): Record<string, T> {
  const next = { ...local }
  for (const [key, record] of Object.entries(incoming)) {
    const current = next[key]
    if (current && record.updatedAt <= current.updatedAt) continue
    next[key] = record
  }
  return next
}
