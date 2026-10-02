/**
 * `flambette-relay` — the Cloudflare deployment of the live-room relay
 * (ADR-0038).
 *
 * This entry owns everything that must happen BEFORE a socket belongs to
 * a room, and nothing else:
 *
 * 1. answer a plain GET with the health payload, so a probe (or an
 *    operator) can tell this relay from the Bun one by its configuration;
 * 2. read the room intent off the upgrade URL — `?op=create|join&room=`
 *    — which is what replaced the client's first post-open message
 *    (the socket already knows what it wants before it is open);
 * 3. spend the create/join throttle budget, keyed on the real client
 *    address;
 * 4. route to the Durable Object that owns that code.
 *
 * The Durable Object then owns the room for the socket's whole life. This
 * file deliberately holds no room state: rooms are per-code objects, so
 * everything here is shareable by construction.
 *
 * A `join` with an unusable code and a throttled attempt are BOTH
 * answered as a WebSocket carrying an `error` message, never as a
 * rejected handshake — the client's room UI is driven by relay messages,
 * so an HTTP 4xx at upgrade time would reach the user as a bare
 * "connection failed" instead of "not a room code" or "slow down".
 */

import { mintLegacyCode, canonicalizeCode } from '../relay-core/codes'
import { RELAY_ERRORS } from '../relay-core/protocol'
import { Room } from './room'
import { makeThrottle } from '../relay-core/throttle'
import { DEFAULT_ATTEMPT_LIMIT, IDLE_TTL_MS, INACTIVITY_TTL_MS, RELAY_SERVICE } from '../relay-core/policy'

export { Room }

/**
 * Per-isolate attempt budget, in the module scope of the isolate.
 *
 * This is deliberately the same weak bound the Bun relay has (its Map
 * dies with the process): household-grade anti-brute-force hardening, not
 * an ACL. Budgets are per IP, not per socket — an attacker opening a
 * socket per attempt must not get a fresh budget each time, which is
 * exactly what the per-socket bucket alone would hand them.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be forged by a client
 * (unlike the `X-Forwarded-For` the compose deployment trusts, which is
 * only safe there because nginx overwrites it — see nginx.conf).
 */
/**
 * Address the current attempt is charged to.
 *
 * `makeThrottle` resolves the peer address through a zero-argument hook
 * (the shape the Bun relay uses, where it reads the socket), and the
 * socket does not exist yet at this point in the request — so the request
 * publishes its address here first. That is safe: an isolate runs one
 * request at a time to completion, and `allow()` is synchronous, so the
 * value can never be read by another attempt.
 */
let currentAddress: string = 'unknown'

/**
 * The per-isolate throttle, built on first use.
 *
 * Deliberately lazy: the limit comes from the RELAY_ATTEMPT_LIMIT var, and
 * a module-scope constant cannot see a binding. This is the same knob the
 * Bun relay reads from `process.env` (server/relay.ts) — the e2e suite
 * raises it for a shared CI IP, and the DO specs pin the boundary at their
 * own value.
 */
let throttle: ReturnType<typeof makeThrottle> | null = null

function attemptLimit(env: Env): number {
  const raw = env.RELAY_ATTEMPT_LIMIT
  const limit = raw === undefined ? DEFAULT_ATTEMPT_LIMIT : Number(raw)
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_ATTEMPT_LIMIT
}

function getThrottle(env: Env): ReturnType<typeof makeThrottle> {
  throttle ??= makeThrottle({
    limit: attemptLimit(env),
    peerAddress: () => currentAddress,
  })
  return throttle
}

/** The edge-set, unforgeable client address. */
function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

function health(env: Env): Response {
  return Response.json({
    service: RELAY_SERVICE,
    inactivityTtlMs: INACTIVITY_TTL_MS,
    idleTtlMs: IDLE_TTL_MS,
    attemptLimit: getThrottle(env).limit,
  })
}

function isUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

/** Refuse at the WebSocket layer, with a relay `error` the client can read. */
function refuseWith(code: string): Response {
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()
  try {
    server.send(JSON.stringify({ type: 'error', code }))
  } catch {
    // The peer vanished before the refusal landed.
  } finally {
    server.close(1000, code)
  }
  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isUpgrade(request)) return health(env)

    const url = new URL(request.url)
    const rawCode = url.searchParams.get('room') ?? ''
    // ADR-0026's join-or-create is the default intent: a bare `?room=X`
    // is a join, and only an explicit `op=create` claims the code.
    const op = url.searchParams.get('op') === 'create' ? 'create' : 'join'
    let code = canonicalizeCode(rawCode)

    if (op === 'create' && !code) {
      // A create that arrived without a code (the hand-typed / link-less
      // path) gets a legacy one here, so the DO can be named at all.
      // A collision surfaces as `code_taken` and the client re-rolls.
      code = mintLegacyCode()
    }
    if (!code) return refuseWith(RELAY_ERRORS.notFound)

    // One attempt against BOTH the per-socket and per-IP budgets. The
    // socket bucket is a per-attempt no-op (each upgrade is a fresh id);
    // the IP bucket is the one doing the work, which is the point — a
    // client that opens a socket per attempt must not get a fresh budget
    // each time.
    currentAddress = clientAddress(request)
    if (!getThrottle(env).allow({ data: { peerId: crypto.randomUUID() } })) {
      return refuseWith(RELAY_ERRORS.rateLimited)
    }

    // Route by name: the code IS the Durable Object's name, so two
    // spellings of one code are already the same object.
    const id = env.ROOM.idFromName(code)
    const stub = env.ROOM.get(id)

    const target = new URL(url)
    target.pathname = '/ws'
    target.search = `?mode=${op}&room=${encodeURIComponent(code)}`
    return stub.fetch(new Request(target, request))
  },
} satisfies ExportedHandler<Env>
