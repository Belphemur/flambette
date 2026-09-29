# Mealime relay

An in-memory WebSocket relay for the planner's live room sync. One user
creates a room, everyone with the code joins, and every client pushes its
whole shared state through the relay. The relay stores nothing but the
latest state per room — conflict resolution lives entirely on the client
(last-write-wins keyed by a monotonic `rev`).

A zero-dependency Bun service (Bun's native WebSocket API — no npm
install step at all).

Run it directly:

```sh
bun relay.mjs      # listens on :8081 (override with PORT)
```

Env knobs (defaults in brackets): `PORT` [8081], `RELAY_ATTEMPT_LIMIT`
[30 per minute per socket/IP], `RELAY_INACTIVITY_TTL_MS` [1h],
`RELAY_IDLE_TTL_MS` [12h].

Or via Docker / from the repo root:

```sh
docker compose up --build
```

The web service's nginx proxies `/ws` (with HTTP upgrade headers) to
`relay:8081`, so the browser only ever talks to the web origin.

## Protocol

JSON text frames, both directions.

| Client → relay | Relay → client |
| --- | --- |
| `{"type":"create"}` | `{"type":"created","code":"…","rev":<int>}` — `rev` is the per-code floor (see Expiry) |
| `{"type":"create","code":"<three words>"}` | `{"type":"created","code":"amber-falcon-lantern","rev":<int>}`, or `{"type":"error","code":"code_taken"}` when that code is live |
| `{"type":"join","code":"ABC123"}` | `{"type":"joined","code":"ABC123","rev":<int\|0>,"state":<obj\|null>}` — for a code the relay does not know: `{"type":"created","code":"…","rev":<int>}` |
| `{"type":"keepalive"}` | `{"type":"keepalive_ack"}` — refreshes the room's 1h inactivity clock. Not throttled. `{"type":"error","code":"not_in_room"}` when the socket is not in a room |
| `{"type":"state","rev":<int>,"state":<obj>}` | fan-out to every *other* peer in the room: `{"type":"state","rev":<int>,"state":<obj>,"from":"<peerId>"}` |
| `{"type":"leave"}` (or socket close) | `{"type":"left"}` |

Errors: `not_found` (join with an unusable code shape — a partial word
code is refused, never coerced), `code_taken`, `rate_limited`,
`bad_json`, `bad_state`, `not_in_room`, `unknown_type`, and
`room_expired` (see Expiry).

Room codes have two accepted shapes: the current three-word code
(`amber-falcon-lantern`, rolled client-side so a user can read it out
before anyone joins — ADR-0021), and the legacy 6-char code from a
Crockford base32 alphabet with all vowels removed
(`0123456789BCDFGHJKLMNPQRSTVWXZ`, uppercase), which the relay still
mints when a `create` asks for no particular code (older clients). A
`join` is canonicalized through the same normalizer on both sides, so
`Mauve-Peacock-Candle`, `mauve-peacock-candle` and a compact spelling
all find the same room.

## Semantics

- **State**: the relay validates only that `state` is a JSON object and
  `rev` a finite number. It stores the latest pair per room and fans out.
- **Join-or-create (ADR-0026)**: a `join` for a code that does not
  exist **creates** the room and answers `created` (the same reply shape
  as the host path, so the client seeds the room with its own state); an
  existing room answers `joined` with its current state. Whoever arrives
  first establishes the room — there is no "room not found" dead end.
- **Empty rooms die immediately (ADR-0026)**: the last peer leaving (or
  its socket closing) deletes the room, state included. A peer that comes
  back re-joins, which re-creates the room.
- **Expiry (ADR-0026)**: two clocks per room, BOTH refreshed by every
  liveness signal — `keepalive` included, because a connected peer that
  keepalives is not an idle room.
  - *Inactivity*: 1h with no `keepalive` and no `state` traffic
    (`RELAY_INACTIVITY_TTL_MS`).
  - *Idle backstop*: 12h since the last interaction of any kind
    (`RELAY_IDLE_TTL_MS`) — redundant defence in depth for peers that
    vanished without a `leave`.
  On firing, the room closes and every peer gets
  `{"type":"error","code":"room_expired","reason":"inactive"|"idle"}`. The
  relay then CLEARS each peer's room code, so a socket left over from the
  dead room can neither write state into, nor `leave` away, a room that
  somebody else has since re-created under the same code. A socket
  belongs to at most one room: joining or creating detaches it from the
  previous one first, so a client that moved on is never notified about
  (or killed by) the room it left.
- **Revisions**: `rev` is monotone per CODE, not per room instance. The
  highest `rev` a code reached survives the room's deletion (pruned after
  the idle TTL) and is handed back in `created`/`joined`, so a re-created
  room continues the household's history instead of restarting at 0 and
  passing a stale snapshot off as newer.
- **Keepalive**: `{"type":"keepalive"}` is the *application* heartbeat —
  it refreshes both room clocks and is deliberately NOT throttled: a
  liveness frame must never be able to spend the create/join budget.
- **Liveness**: heartbeat ping/pong every 30s; a socket that misses a
  pong is terminated and removed from its room. This is transport-level
  only and deliberately does **not** refresh room activity — a client
  behind a half-open socket is exactly what the 1h clock is for.
- **Health**: the HTTP response is a JSON echo of the running
  configuration (`inactivityTtlMs`, `idleTtlMs`, `attemptLimit`) so two
  relays can be told apart without guessing.
- **Persistence**: none. Restarting the relay empties all rooms; clients
  re-create/re-join via their reconnect logic (a `join` re-creates the
  room, so a relay restart is self-healing for the first peer back).
