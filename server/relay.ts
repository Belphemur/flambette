/**
 * Mealime Planner — live room relay, self-host adapter.
 *
 * Every DECISION lives in `./relay-core` (ADR-0040); this file is the Bun
 * half of the seam and does three things only:
 *
 * 1. reads the configuration the core deliberately does not know about
 *    (`process.env`, which workerd does not have);
 * 2. implements the core's storage INTENTS over the SQLite database that
 *    `./relaySqlite` opens and migrates at startup (ADR-0088 §1) — the
 *    in-process Maps stopped being the store of record;
 * 3. maps WebSocket events onto core verdicts and back onto the wire.
 *
 * Zero dependencies: Bun's native WebSocket support (`Bun.serve`) and
 * Bun's built-in `bun:sqlite` — no npm install step, and no build step
 * (Bun runs the TypeScript directly).
 *
 * Rooms are keyed by canonical code and hold whole-state snapshots;
 * conflict resolution belongs to the client, via a monotonic `rev` the
 * relay only stores and fans out (ADR-0006). The room ROW survives its
 * last peer (ADR-0088 §5, like the Durable Object) until the expiry
 * clock fires, and it survives a PROCESS restart: the startup sweep
 * re-arms the wake-ups of every persisted room and orphaned floor.
 *
 * Run: `bun server/relay.ts` (listens on :8081, override with PORT env).
 */

import {
  createRoomRegistry,
  normalizeProfile,
  normalizeProfileName,
  peersFrame,
  renamedProfile,
  type PeerProfile,
  type RoomRegistry,
  type RoomStore,
} from './relay-core/lifecycle'
import { canonicalizeCode, mintLegacyCode, resolveCreateIntent } from './relay-core/codes'
import { healthPayload, ROOM_TTL_MS as ROOM_TTL_DEFAULT_MS, parsePositiveNumber } from './relay-core/policy'
import { parseClientFrame, RELAY_ERRORS, type RelayMessage } from './relay-core/protocol'
import type { ExpiryReason } from './relay-core/lifecycle'
import { makeThrottle, MemoryAttemptBuckets } from './relay-core/throttle'
import { createSqliteStores, openRelayDatabase, persistedDeadlines } from './relaySqlite'

/* ------------------------------------------------------------------ config */

const PORT = parsePositiveNumber(process.env.PORT, 8081)
/**
 * The ONE room-retention window (ADR-0038's unification addendum). The
 * pre-collapse design had a second `RELAY_IDLE_TTL_MS` knob; its separate
 * meaning is gone. The old `RELAY_INACTIVITY_TTL_MS` is honored as a
 * deprecated fallback so an existing deployment's override survives.
 */
const ROOM_TTL_MS = parsePositiveNumber(
  process.env.RELAY_ROOM_TTL_MS,
  // The deprecated fallback goes through the parser too, not through `??`:
  // a set-but-empty or nonsense RELAY_ROOM_TTL_MS must fall through to it
  // (parsePositiveNumber treats both as absent), so an existing
  // deployment's old override still wins over the default (kody review).
  parsePositiveNumber(process.env.RELAY_INACTIVITY_TTL_MS, ROOM_TTL_DEFAULT_MS),
)
/**
 * The relay's room state persists here (ADR-0088 §1) — the Docker compose
 * volume mounts the directory; `:memory:` is an explicit opt-in for tests.
 */
const RELAY_DB_PATH = process.env.RELAY_DB_PATH ?? '/data/relay.sqlite3'
/** Transport liveness only — see the heartbeat at the bottom. */
const HEARTBEAT_MS = 30_000

/* -------------------------------------------------------------- transports */

/**
 * The slice of `ServerWebSocket` this adapter uses, declared structurally
 * so the relay typechecks without pulling in Bun's own type package (the
 * repo has no `@types/bun`, and the ADR forbids a new dependency for it).
 * The worker adapter types the same concept from `@cloudflare/...`.
 */
interface Socket {
  data: SocketData
  readyState: number
  send: (payload: string) => void
  ping: () => void
  terminate: () => void
}

interface SocketData {
  peerId: string
  isAlive: boolean
  /** The canonical code of the ONE room this socket may write into. */
  roomCode: string | undefined
  /** Throttle key: the real client address, captured at upgrade time. */
  ip: string
  /** A create/join carried in the upgrade URL (ADR-0038). */
  intent: { op: 'create' | 'join'; code: string } | undefined
  /**
   * The socket's identity (ADR-0063): the client's join/create carries
   * `pid`/`pname` on the SAME upgrade URL (the ADR-0038 intent carrier),
   * and a `profile` message renames mid-session. Null = a profile-less
   * (old-version) peer, which the roster shows as a Guest row.
   */
  profile: PeerProfile | null
}

/**
 * The slice of Bun's upgrade server this adapter uses. Declared here
 * rather than imported: the repo ships no `@types/bun`, and the ADR
 * forbids a new dependency for a type package. Being explicit also keeps
 * the adapter honest about how little of Bun it touches.
 */
interface UpgradeServer {
  upgrade: (req: Request, options: { data: SocketData }) => boolean
  requestIP: (req: Request) => { address: string } | null
}

declare const Bun: {
  serve: (options: {
    port: number
    fetch: (req: Request, srv: UpgradeServer) => Response | undefined
    websocket: {
      open: (ws: Socket) => void
      message: (ws: Socket, data: string | Uint8Array) => void
      pong: (ws: Socket) => void
      close: (ws: Socket) => void
    }
  }) => unknown
}

/* ------------------------------------------------------------------- state */

/** One live room: the core's registry over its SQLite-backed store, plus peers. */
interface Room {
  code: string
  registry: RoomRegistry
  peers: Set<Socket>
  timer: ReturnType<typeof setTimeout> | undefined
}

const rooms = new Map<string, Room>()
/**
 * The relay's database, opened and migrated before `Bun.serve` — see the
 * startup block at the bottom. The store factory closes over it.
 */
let db: ReturnType<typeof openRelayDatabase> | undefined
let sqliteStores: ((code: string) => RoomStore) | undefined
/**
 * Wake-ups for codes with NO live shell: an emptied room's expiry
 * countdown (ADR-0088 §5 — the ROW outlives its last peer, the in-memory
 * shell does not) and an orphaned floor's prune. Kept apart from the
 * rooms' own timers so a room dying cannot cancel its floor's prune —
 * and so neither timer is cancelled by the other's lifecycle.
 */
const floorTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** All live sockets (Bun has no iterable `server.clients` — track manually). */
const sockets = new Set<Socket>()

/** Monotonic peer id, used only as the fan-out `from` attribution. */
let nextPeerId = 0

/**
 * The core's storage intents over the SQLite database (see
 * `./relaySqlite`) — the whole "adapter owns state" half of ADR-0040. The
 * Maps stopped being the store of record: they hold only the in-memory
 * shells (peer sets, timers) whose lifetime is the process's.
 */
function storeFor(code: string): RoomStore {
  if (!sqliteStores) throw new Error('relay database not opened')
  return sqliteStores(code)
}

/**
 * The core, wired to this adapter's clock, timer sink and store.
 *
 * Built per live room AND per floor prune: the Bun registry is a few
 * closures over the store, so a throwaway one costs nothing and keeps the
 * prune decision in the core instead of duplicating it here.
 */
function registryFor(code: string): RoomRegistry {
  return createRoomRegistry({
    code,
    store: storeFor(code),
    roomTtlMs: ROOM_TTL_MS,
    now: () => Date.now(),
    arm: (deadline) => armRoom(code, deadline),
    onExpire: (expired, reason) => notifyExpired(expired, reason),
  })
}

/**
 * The single timer sink: re-arm the wake-up for whichever deadline the
 * core just decided on, then let the core decide what a wake-up means.
 * Bun's `setTimeout` is used rather than the Durable Object's alarm only
 * because this adapter never hibernates — a live process always has
 * timers.
 *
 * A deadline can belong to a room OR to an orphaned floor (the floor
 * outlives its room, so pruning it needs its own wake-up). They are kept
 * in separate maps because they have different lifetimes: the room timer
 * dies with the room, the floor timer outlives it.
 */
function armRoom(code: string, deadline: number): void {
  const delay = clampTimerDelay(deadline - Date.now())
  const room = rooms.get(code)
  if (room) {
    if (room.timer) clearTimeout(room.timer)
    room.timer = setTimeout(() => {
      room.timer = undefined
      // Expiry (tick) is the only path that deletes a room now (ADR-0088
      // §5) — the core has already dropped the rows and armed the floor's
      // prune by the time it returns. A live verdict (a keepalive moved
      // the deadline, an early wake-up re-armed) keeps the shell.
      if (room.registry.tick() === null) return
      rooms.delete(code)
      // The floor prune that tick() armed went through `arm()` while this
      // shell was still mapped, so the wake-up landed on room.timer. Drop
      // the misrouted handle — it is the only thing left referencing the
      // shell — and re-arm through the shell-less path, whose tick()
      // schedules (or fires) the floor prune: otherwise every expired
      // room keeps a live callback referencing it for up to the room TTL
      // (qodo review).
      if (room.timer) clearTimeout(room.timer)
      registryFor(code).tick()
    }, delay)
    return
  }
  const pending = floorTimers.get(code)
  if (pending) clearTimeout(pending)
  floorTimers.set(
    code,
    setTimeout(() => {
      floorTimers.delete(code)
      // The room is gone; the core prunes the floor if it has aged out and
      // re-arms the timer if it has not.
      registryFor(code).tick()
    }, delay),
  )
}

/**
 * Node/Bun cap `setTimeout` at the 32-bit signed limit (~24.8 days) and
 * SILENTLY CLAMP anything longer to 1ms — which would turn the room-TTL
 * wake-up (30 days, `ROOM_TTL_MS`) into a 1ms fire → `tick()` sees an
 * early wake → re-arm → 1ms fire … a hot loop with a clamp warning per
 * iteration. Capping the delay here makes the wake-up fire EARLY instead;
 * the core's early-wake path (`tick` re-arms when `t < deadline`) then
 * schedules the remaining time through this same clamp, so expiry still
 * lands on the true deadline after a few legitimate wake-ups.
 */
function clampTimerDelay(ms: number): number {
  return Math.min(Math.max(0, ms), 2_147_483_647)
}

function roomFor(code: string): Room {
  const existing = rooms.get(code)
  if (existing) return existing
  // A shell-less wake-up for this code — an expiry countdown left behind
  // by the last peer's departure, or a floor prune — is superseded: from
  // here the shell's own touch→arm cycle takes the wake-ups (kody
  // review).
  const pending = floorTimers.get(code)
  if (pending) clearTimeout(pending)
  floorTimers.delete(code)
  const room: Room = {
    code,
    peers: new Set(),
    timer: undefined,
    registry: registryFor(code),
  }
  rooms.set(code, room)
  return room
}

/**
 * Tell every peer the room is gone BEFORE the core drops it, so the client
 * stops instead of re-joining a corpse (`room_expired` is terminal on the
 * client — a re-join would join-or-create an empty room and read as silent
 * household data loss).
 *
 * Only sockets STILL in this room are notified, and each one has its
 * `roomCode` cleared: a stale socket that kept the code could otherwise
 * write into — or `leave` and delete — a room re-created under it.
 */
function notifyExpired(code: string, reason: ExpiryReason): void {
  const room = rooms.get(code)
  if (!room) return
  for (const peer of room.peers) {
    if (peer.data.roomCode !== code) continue
    peer.data.roomCode = undefined
    send(peer, { type: 'error', code: RELAY_ERRORS.roomExpired, reason })
  }
}

function send(ws: Socket, payload: RelayMessage): void {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(payload))
}

/* --------------------------------------------------------------- throttle */

/**
 * Brute-force throttle: create/join attempts are limited per socket AND
 * per IP, so a guessed-code flood gets `rate_limited`. State fan-out
 * between joined peers is never charged. The arithmetic is the core's; the
 * limit comes from the environment because that is a deployment knob.
 *
 * The address is the REAL peer IP, captured at upgrade time: behind the
 * compose nginx the socket address is nginx's own container IP, which
 * would make every household share one budget — the same collapse that
 * failed 4-9 room-join specs in a 224-test e2e run until
 * `RELAY_ATTEMPT_LIMIT` was raised.
 */
const throttle = makeThrottle({
  limit: parsePositiveNumber(process.env.RELAY_ATTEMPT_LIMIT, 30),
  buckets: new MemoryAttemptBuckets(),
  peerAddress: (peer) => (peer as Socket).data?.ip ?? 'unknown',
})

/* -------------------------------------------------------------- membership */

/**
 * Tell every attached peer how many of them there are (ADR-0049) and who
 * exactly they are (ADR-0063).
 *
 * Membership is the ONE thing the core cannot broadcast: which sockets
 * belong to a room is the whole difference between a Bun `Set` and a
 * hibernated Durable Object, so each adapter walks its own peer set. The
 * arithmetic and the policy ("on every membership change") are shared;
 * the frame itself — count plus the DEDUPED people list — is the core's
 * `peersFrame`. A peer whose socket has already died is skipped by
 * `send`'s guard, so a stale socket cannot turn a fan-out into an
 * exception.
 */
function broadcastPeers(room: Room): void {
  const frame = peersFrame(
    room.peers.size,
    [...room.peers].map((peer) => peer.data.profile),
  )
  for (const peer of room.peers) send(peer, frame)
}

/** Put a socket into `code`, detaching it from any previous room first. */
function attach(ws: Socket, code: string): void {
  // Already in this room: DO NOT detach. `detach` runs `leave`, and a
  // socket that is the room's only peer would take the room down with it
  // — a client that re-sends `join` for the room it is already in (a
  // retry, or the URL intent on a reconnect that raced) would get a
  // `joined` carrying real state and then find every later push refused
  // with `bad_state`. The admission verdict was already computed against
  // the room this socket is still in, so returning early is also the
  // cheaper answer.
  if (ws.data.roomCode === code && rooms.get(code)?.peers.has(ws)) return
  detach(ws)
  const room = roomFor(code)
  room.peers.add(ws)
  ws.data.roomCode = code
}

/**
 * Remove a socket from its room. Since ADR-0088 §5 the room does NOT die
 * with its last peer — that was the one deliberate behavioural difference
 * from the Durable Object, now closed: the row (and its state) survives
 * until the expiry clock — 30 days (ADR-0038's unification addendum) —
 * fires, so a
 * phone that reconnects after a tunnel, a reload or a relay restart gets
 * its plan back instead of re-seeding an empty room. The wake-up the last
 * touch armed is exactly the expiry deadline, so it stays live and the
 * timer callback's tick() closes the room later — no extra bookkeeping
 * here, which is why `registry.leave()` is gone entirely.
 */
function detach(ws: Socket): void {
  const code = ws.data.roomCode
  if (!code) return
  const room = rooms.get(code)
  ws.data.roomCode = undefined
  if (!room) return
  room.peers.delete(ws)
  if (room.peers.size > 0) {
    // Everyone who is left learns the new headcount.
    broadcastPeers(room)
    return
  }
  // Last peer out. ADR-0088 §5 keeps the ROW (state, floor, serial) until
  // the expiry clock fires — the reconnect-after-a-tunnel promise — but
  // the in-memory shell does not have to outlive its last socket (kody
  // release it, and continue the wake-up through the shell-less
  // timer path, whose tick() expires the row (and then prunes its floor)
  // exactly as an in-memory shell would. The deadline is re-read from the
  // row the last touch refreshed.
  const row = storeFor(code).read()
  rooms.delete(code)
  if (room.timer) clearTimeout(room.timer)
  if (row) armRoom(code, row.deadline)
}

/* ---------------------------------------------------------------- admission */

/**
 * Adopt a profile carried by a join/create MESSAGE (ADR-0063) — the form
 * pre-ADR-0038 clients and test harnesses use. First contact only: a
 * socket's id is fixed at its first join, so a profile already present
 * (from the upgrade URL, or an earlier frame) is never replaced. An
 * unusable claim is silence, never a refusal — the peer stays/becomes a
 * Guest row.
 */
function adoptMessageProfile(ws: Socket, raw: unknown): void {
  if (ws.data.profile) return
  const adopted = normalizeProfile(raw)
  if (adopted) ws.data.profile = adopted
}

/** A legacy mint, avoiding codes that are currently live. */
function mintFreeCode(): string {
  let code = mintLegacyCode()
  for (let i = 0; i < 8 && rooms.has(code); i++) code = mintLegacyCode()
  return code
}

/**
 * Ask the core what an upgrade should be answered with, then translate the
 * verdict into a frame. Both transports (the URL intent and the message
 * protocol) funnel through here, so a create/join pays one budget and one
 * set of replies regardless of how it arrived.
 */
function admit(ws: Socket, code: string, mode: 'create' | 'join'): void {
  const room = roomFor(code)
  // The PRE-ARRIVAL headcount: `attach` deliberately keeps a socket that
  // re-joins the room it is ALREADY in, so a set size that already
  // contains this socket would make the core's `livePeers + 1` over-count
  // by one. Honest input makes `verdict.count` correct by construction —
  // no clamp to patch the verdict with afterwards.
  const preArrival = room.peers.size - (room.peers.has(ws) ? 1 : 0)
  // Two numbers on purpose. The core's create-refuse gate asks "is anyone
  // in this room?" and must see TRUE occupancy: a sole member re-sending
  // `create` for its own code has a self-excluded headcount of 0, and
  // answering that with `establish` would overwrite the stored snapshot
  // while the socket stays attached. The REPORTED count, however, wants
  // the pre-arrival headcount — `attach` keeps a socket that is already
  // in the set, so a full count there would over-report by one. For
  // create the two agree whenever establish is possible (an occupied room
  // is refused before any count is reported); for join only the
  // pre-arrival form is honest.
  const verdict = room.registry.admit(
    mode,
    mode === 'create' ? room.peers.size : preArrival,
  )
  if (verdict.kind === 'refuse') {
    send(ws, { type: 'error', code: verdict.error })
    return
  }
  attach(ws, code)
  // `rev` is the per-code FLOOR, never the room's current rev: a client
  // seeds above it, so a re-created room cannot pass a stale snapshot off
  // as newer (review F4). `count` is the headcount after this peer joined
  // (ADR-0049) — the same number `broadcastPeers` is about to tell the
  // room, stitched in so the joining peer learns it without waiting for a
  // second frame.
  const count = verdict.count
  if (verdict.kind === 'establish') {
    send(ws, { type: 'created', code: verdict.code, rev: verdict.rev, count })
  } else {
    send(ws, { type: 'joined', code: verdict.code, rev: verdict.rev, state: verdict.state, count })
  }
  broadcastPeers(room)
}

/**
 * A create. The budget is charged HERE so a URL-carried intent and the
 * legacy message pay the same price. WHICH code qualifies is the core's
 * decision (`resolveCreateIntent`): only an empty/absent code mints, a
 * caller that named a specific code is answered for THAT code, and a
 * named code that does not qualify is refused — never minted over.
 */
function performCreate(ws: Socket, rawCode: unknown, { legacyMessage = false } = {}): void {
  if (!throttle.allow(ws)) {
    send(ws, { type: 'error', code: RELAY_ERRORS.rateLimited })
    return
  }
  const intent = resolveCreateIntent(rawCode, { messageForm: legacyMessage })
  if (intent.kind === 'notFound') {
    send(ws, { type: 'error', code: RELAY_ERRORS.notFound })
    return
  }
  admit(ws, intent.kind === 'create' ? intent.code : mintFreeCode(), 'create')
}

/**
 * A join-or-create (ADR-0026): whoever arrives first ESTABLISHES the room
 * under the code they asked for, which is what makes a household room
 * startable by any peer. An unusable code shape answers `not_found`,
 * which the client maps to "not a room code".
 */
function performJoin(ws: Socket, rawCode: unknown): void {
  if (!throttle.allow(ws)) {
    send(ws, { type: 'error', code: RELAY_ERRORS.rateLimited })
    return
  }
  const code = canonicalizeCode(rawCode)
  if (!code) {
    send(ws, { type: 'error', code: RELAY_ERRORS.notFound })
    return
  }
  admit(ws, code, 'join')
}

/* ------------------------------------------------------------------- server */

/**
 * Open and migrate the database BEFORE anything serves (ADR-0088 §4): a
 * relay that answers a half-migrated schema is worse than one that refuses
 * to start. The startup sweep then re-arms the wake-ups of every persisted
 * room and orphaned floor — a restart is a resumption, not a reset, and a
 * room nobody rejoined still reaches the clocks that are supposed to
 * delete it.
 */
try {
  db = openRelayDatabase(RELAY_DB_PATH)
  sqliteStores = createSqliteStores(db, () => Date.now())
  const { rooms: roomDeadlines, floors: floorDeadlines } = persistedDeadlines(db, ROOM_TTL_MS)
  for (const { code, deadline } of roomDeadlines) {
    // Shell-less on purpose (kody review): a persisted room nobody has
    // rejoined gets a wake-up, not a live shell — the registry is built
    // when a peer actually joins. `armRoom` routes a code with no shell
    // to the shell-less timer path, whose tick() expires the row (and
    // then prunes its floor) exactly as a live shell would.
    armRoom(code, deadline)
  }
  for (const { code, deadline } of floorDeadlines) {
    // A code with a room row keeps the ROOM deadline armed above; its
    // floor prune is armed by tick() when the room expires.
    if (floorTimers.has(code)) continue
    floorTimers.set(
      code,
      setTimeout(() => {
        floorTimers.delete(code)
        registryFor(code).tick()
      }, clampTimerDelay(deadline - Date.now())),
    )
  }
} catch (err) {
  console.error(`[relay] ${(err as Error).message}`)
  process.exit(1)
}

try {
  Bun.serve({
    port: PORT,
    // Plain HTTP responses so health probes (the Playwright webServer check,
    // load balancers, the CI image smoke-run) get a 200; WebSocket upgrades
    // are handed to the websocket handler below.
    fetch(req, srv) {
      const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      // `requestIP` THROWS for a plain socket argument, so it is only
      // reached through the core throttle's guarded path — never called
      // unguarded from here.
      const ip = forwarded || srv.requestIP(req)?.address || 'unknown'
      // A URL-carried intent (ADR-0038) makes create/join happen the moment
      // the socket opens instead of racing a first message. Only a query
      // that SAYS something carries an intent: a bare /ws upgrade (the e2e
      // suite's direct-dial peers) keeps speaking the message protocol,
      // which stays supported.
      const url = new URL(req.url)
      const carriesIntent = url.searchParams.has('op') || url.searchParams.has('room')
      const intent = carriesIntent
        ? {
            op: url.searchParams.get('op') === 'create' ? ('create' as const) : ('join' as const),
            code: url.searchParams.get('room') ?? '',
          }
        : undefined
      if (
        srv.upgrade(req, {
          data: {
            isAlive: true,
            roomCode: undefined,
            ip,
            intent,
            peerId: '',
            // ADR-0063: the join/create profile rides the SAME upgrade URL
            // as the intent (pid/pname), so the very first roster fan-out
            // is already complete — no second round-trip, no Guest flash.
            // The core's normalizeProfile decides whether the claim is
            // usable; an invalid one degrades to a Guest row.
            profile: normalizeProfile({
              id: url.searchParams.get('pid') ?? undefined,
              name: url.searchParams.get('pname') ?? undefined,
            }),
          },
        })
      )
        return undefined
      // The health body echoes the lifecycle configuration so a test (or an
      // operator) can tell two relays apart without guessing: a leftover
      // listener from an earlier run with DIFFERENT TTLs must never be
      // mistaken for the one a spec asked for.
      return new Response(JSON.stringify(healthPayload({
        roomTtlMs: ROOM_TTL_MS,
        attemptLimit: throttle.limit,
      })), { headers: { 'content-type': 'application/json' } })
    },
    websocket: {
      open(ws) {
        ws.data.peerId = `p${++nextPeerId}`
        sockets.add(ws)
        const intent = ws.data.intent
        if (!intent) return
        ws.data.intent = undefined
        if (intent.op === 'create') performCreate(ws, intent.code)
        else performJoin(ws, intent.code)
      },

      message(ws, data) {
        // The frame gate lives in the core (ADR-0040): unparseable bytes
        // AND a parsed non-object frame are refused `bad_json` on both
        // relays — the Bun adapter used to answer `unknown_type` here
        // through its switch default.
        const frame = parseClientFrame(data)
        if (!frame.ok) {
          send(ws, { type: 'error', code: frame.error })
          return
        }
        const msg = frame.msg

        const room = ws.data.roomCode ? rooms.get(ws.data.roomCode) : undefined
        // Membership, not just a code: a socket whose room expired (its
        // `roomCode` was cleared) or that a later join detached must not
        // write into or keep alive a room it is not in (review F2/F3).
        const member = Boolean(room?.peers.has(ws))

        switch (msg?.type) {
          case 'create':
            // The message form can carry a profile (ADR-0063); adopt it
            // BEFORE admission so the created reply and the first roster
            // fan-out are already complete.
            adoptMessageProfile(ws, msg.profile)
            performCreate(ws, msg.code, { legacyMessage: true })
            break

          case 'join':
            adoptMessageProfile(ws, msg.profile)
            performJoin(ws, msg.code)
            break

          case 'profile': {
            // A mid-session rename (ADR-0063). The id is FIXED at join —
            // any `id` on this frame is ignored — so only the name moves.
            if (!member || !room) {
              send(ws, { type: 'error', code: RELAY_ERRORS.notInRoom })
              return
            }
            if (ws.data.profile) {
              const name = normalizeProfileName(msg.name)
              const id = ws.data.profile.id
              ws.data.profile = { ...ws.data.profile, name }
              // A rename is authoritative for EVERY socket sharing the
              // identity (ADR-0063 dedupe): a device's second tab renaming
              // must not leave the first tab's stale name as the roster's
              // row for that person (review — the dedupe keeps the FIRST
              // socket's profile, so only-the-sender would go stale).
              for (const peer of room.peers) {
                if (peer === ws) continue
                peer.data.profile = renamedProfile(peer.data.profile, id, name)
              }
            } else {
              // First contact from a client that never carried a profile at
              // upgrade: adopt id + name, verbatim from the frame. This is
              // the socket's FIRST adoption, not a later change, so the
              // "id fixed at join" rule still holds.
              const adopted = normalizeProfile(msg)
              if (adopted) ws.data.profile = adopted
            }
            // The roster changed for everyone; the count did not.
            broadcastPeers(room)
            break
          }

          case 'keepalive': {
            // Application-level liveness (ADR-0026). NOT throttled: it
            // carries no guessable input and must never be able to burn a
            // create/join budget. The answer is deliberately NOT named
            // `pong` — that name belongs to the socket-level beat below.
            // The core refreshes the expiry clock, so a 30-day-connected
            // household is never closed (review F1).
            if (!member || !room) {
              send(ws, { type: 'error', code: RELAY_ERRORS.notInRoom })
              return
            }
            if (room.registry.keepalive().kind === 'ok') send(ws, { type: 'keepalive_ack' })
            else send(ws, { type: 'error', code: RELAY_ERRORS.notInRoom })
            break
          }

          case 'state': {
            if (!member || !room) {
              send(ws, { type: 'error', code: RELAY_ERRORS.badState })
              return
            }
            // ADR-0063: the fan-out `from` is the SENDER's profile id when
            // it has one (attribution by device identity), the per-code
            // serial otherwise (legacy peers keep the old value).
            const verdict = room.registry.push(
              msg.rev,
              msg.state,
              ws.data.profile?.id ?? ws.data.peerId,
            )
            if (!verdict.ok) {
              send(ws, { type: 'error', code: verdict.error })
              return
            }
            for (const peer of room.peers) {
              if (peer !== ws) send(peer, verdict.fanOut)
            }
            break
          }

          case 'leave':
            detach(ws)
            send(ws, { type: 'left' })
            break

          default:
            send(ws, { type: 'error', code: RELAY_ERRORS.unknownType })
        }
      },

      pong(ws) {
        ws.data.isAlive = true
      },

      close(ws) {
        sockets.delete(ws)
        detach(ws)
      },
    },
  })
} catch (err) {
  console.error(`[relay] ${(err as Error).message}`)
  process.exit(1)
}

console.log(
  `[relay] listening on :${PORT} (room TTL ${Math.round(ROOM_TTL_MS / 1000)}s, db ${RELAY_DB_PATH})`,
)

/**
 * Prune dead sockets: a missed pong marks the socket, the next beat
 * terminates it. TRANSPORT liveness only — deliberately it does not touch
 * room activity, which is what `keepalive` is for.
 */
const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    if (socket.data.isAlive === false) {
      socket.terminate()
      continue
    }
    socket.data.isAlive = false
    socket.ping()
  }
}, HEARTBEAT_MS)

process.on('exit', () => clearInterval(heartbeat))