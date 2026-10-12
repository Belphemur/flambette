/**
 * The WebSocket refusal flow, shared by the worker entry and the room
 * Durable Object (ADR-0038). This is workerd-only — it builds a Response,
 * so it does not belong in the runtime-agnostic core.
 *
 * Refusals are still WebSockets, not rejected handshakes — the client's
 * room UI is driven by relay messages, so an HTTP 4xx at upgrade time
 * would surface as a bare "connection failed" instead of "that code is
 * taken" / "slow down".
 */
import type { RelayErrorCode } from '../relay-core/protocol'

/**
 * Refuse an already-created socket pair: answer with a relay `error` and
 * close. The caller owns the pair (the room DO creates one before it
 * knows the admission verdict, so the accept path can reuse it).
 */
export function refuseSocket(client: WebSocket, server: WebSocket, code: RelayErrorCode): Response {
  // `accept()` (not `ctx.acceptWebSocket`) is deliberate: a refused
  // socket is never hibernated, so it cannot linger in a room's peer set
  // and cannot be revived by a later message. The client end is still
  // what gets returned, which is what completes the handshake and
  // delivers the error.
  server.accept()
  try {
    server.send(JSON.stringify({ type: 'error', code }))
  } catch {
    // The peer vanished before the refusal could land; nothing to do.
  } finally {
    server.close(1000, code)
  }
  return new Response(null, { status: 101, webSocket: client })
}
