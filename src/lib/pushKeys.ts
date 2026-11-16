/**
 * The household-notification trigger keys (ADR-0102) — the CLIENT half of
 * the vocabulary. The relay core (`server/relay-core/push.ts`) owns the
 * same union on the server side; the two are deliberately mirrored, never
 * shared live, exactly like the room-store type convention: the client's
 * build must not drag the relay's import graph into the bundle (and vice
 * versa). The relay refuses any key outside ITS copy of the union, so a
 * drifted client can never invent a trigger the server would speak.
 */

/** One household event a member can be pushed about. */
export type PushTriggerKey = 'plan-started' | 'grocery-finished'

/** The runtime list, for validation at the frame boundary. */
export const PUSH_TRIGGER_KEYS: readonly PushTriggerKey[] = ['plan-started', 'grocery-finished']

/** Type-guard the wire value: an unknown key is silence, never an error. */
export function isPushTriggerKey(value: unknown): value is PushTriggerKey {
  return (
    typeof value === 'string' && (PUSH_TRIGGER_KEYS as readonly string[]).includes(value)
  )
}
