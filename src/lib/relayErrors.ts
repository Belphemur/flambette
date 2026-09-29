/**
 * How the client reacts to a relay error code (ADR-0026).
 *
 * Kept pure and out of the store so the decision — in particular
 * "stop retrying vs. keep the backoff running" — is unit-testable
 * without a socket or a Pinia instance.
 */

export type RelayErrorOutcome = {
  /** User-facing message, or null when the store should handle the code itself. */
  message: string | null
  /**
   * false    = give up permanently: clear the stored code and stop the
   *   reconnect loop (the room is gone; retrying would recreate it as a
   *   brand-new empty room, silently losing the household state).
   * true     = the caller may retry (e.g. rate_limited, transient).
   * 'ignore' = our OWN frame was refused and the room is untouched: do
   *   NOTHING. Recycling the socket would send `leave` and, as the last
   *   peer, delete the very room the client is standing in (review F6).
   * null     = the store handles this code itself (code_taken re-roll).
   */
  retry: boolean | 'ignore' | null
}

const OUTCOMES: Record<string, RelayErrorOutcome> = {
  // The room expired (ADR-0026) or never existed on a relay that has
  // not been updated for join-or-create. Either way: stop retrying.
  room_expired: { message: 'Room closed — it expired after a period of inactivity', retry: false },
  not_found: { message: 'Room not found — it may have expired', retry: false },
  // Transient: the budget refills, so the backoff may keep trying.
  rate_limited: { message: 'Room error — rate_limited', retry: true },
  // The relay says this socket is not in a room — its room expired or was
  // detached — so the room really IS gone for us: re-join and re-seed.
  not_in_room: { message: null, retry: true },
  // Our own frames were refused; the room and this socket are fine.
  // Review F6: these must NOT recycle the socket — that sent `leave` and,
  // for a single-peer room, deleted the room and its state.
  bad_state: { message: null, retry: 'ignore' },
  bad_json: { message: null, retry: 'ignore' },
  unknown_type: { message: null, retry: 'ignore' },
  // The store re-rolls and re-sends `create`; it owns this one.
  code_taken: { message: null, retry: null },
}

export function describeRelayError(code: unknown): RelayErrorOutcome {
  const key = String(code ?? 'unknown')
  return (
    OUTCOMES[key] ?? {
      message: `Room error — ${key}`,
      // Unknown errors surface instead of spinning in 'connecting'
      // forever (a hung relay once left every chip at "◌ Connecting").
      retry: false,
    }
  )
}
