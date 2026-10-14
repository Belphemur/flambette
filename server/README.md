# Mealime relay

A WebSocket relay for the planner's live room sync, persisting to SQLite.
One user creates a room, everyone with the code joins, and every client
pushes its whole shared state through the relay. The relay stores the
latest state per room — split across one table per synchronized store
(ADR-0088) — and conflict resolution lives entirely on the client
(last-write-wins keyed by a monotonic `rev`).

A zero-dependency Bun service (Bun's native WebSocket API and its
built-in `bun:sqlite` — no npm install step at all).

Run it directly:

```sh
bun relay.ts      # listens on :8081 (override with PORT)
```

Env knobs (defaults in brackets): `PORT` [8081], `RELAY_DB_PATH`
[`/data/relay.sqlite3` — set it to `:memory:` to run without persistence,
e.g. in tests], `RELAY_ATTEMPT_LIMIT` [30 per minute per socket/IP],
`RELAY_ROOM_TTL_MS` [30 days] — the ONE room-retention window (ADR-0038's
2026-10-14 addendum unified the old inactivity/idle clock pair into it;
the deprecated `RELAY_INACTIVITY_TTL_MS` is still honored as a fallback).

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
| `{"type":"keepalive"}` | `{"type":"keepalive_ack"}` — refreshes the room's 30-day inactivity clock. Not throttled. `{"type":"error","code":"not_in_room"}` when the socket is not in a room |
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
- **Empty rooms persist (ADR-0088 §5)**: the last peer leaving no longer
  deletes the room — the row (and its per-store state) survives until the
  expiry clock below fires, on this relay and the Durable Object alike, so
  a phone that reconnects after a tunnel, a reload or a relay restart gets
  its plan back instead of re-seeding an empty room.
- **Expiry (ADR-0026, unified by ADR-0038's 2026-10-14 addendum)**: ONE
  clock per room, refreshed by every liveness signal — `keepalive`
  included, because a connected peer is not a silent room. 30 days with no
  `keepalive` and no `state` traffic (`RELAY_ROOM_TTL_MS`) and the room is
  deleted; the same TTL ages out the rev floor once the room is gone. (The
  pre-unification design carried a second "idle backstop" clock — with
  both windows at 30 days it collapsed into this one.)
  On firing, the room closes and every peer gets
  `{"type":"error","code":"room_expired","reason":"inactive"}`. The
  relay then CLEARS each peer's room code, so a socket left over from the
  dead room can neither write state into, nor `leave` away, a room that
  somebody else has since re-created under the same code. A socket
  belongs to at most one room: joining or creating detaches it from the
  previous one first, so a client that moved on is never notified about
  (or killed by) the room it left.
- **Revisions**: `rev` is monotone per CODE, not per room instance. The
  highest `rev` a code reached survives the room's deletion (pruned after
  the room TTL) and is handed back in `created`/`joined`, so a re-created
  room continues the household's history instead of restarting at 0 and
  passing a stale snapshot off as newer.
- **Keepalive**: `{"type":"keepalive"}` is the *application* heartbeat —
  it refreshes the room's expiry clock and is deliberately NOT throttled: a
  liveness frame must never be able to spend the create/join budget.
- **Liveness**: heartbeat ping/pong every 30s; a socket that misses a
  pong is terminated and removed from its room. This is transport-level
  only and deliberately does **not** refresh room activity — a client
  behind a half-open socket is exactly what the inactivity clock is for.
- **Health**: the HTTP response is a JSON echo of the running
  configuration (`roomTtlMs`, `attemptLimit`) so two
  relays can be told apart without guessing.
- **Persistence**: room state is stored in a SQLite database — one table
  per synchronized store plus the room/floor rows — opened in WAL mode at
  `RELAY_DB_PATH` (default `/data/relay.sqlite3`), with the schema managed
  by the migration runner shared with the Cloudflare Durable Object
  (ADR-0088 §4). Point the Docker volume at `/data` (the compose file
  does) and a restart resumes every room's state, rev floor and peer
  serial; the clock still deletes a room that stays silent. The
  deprecated `room.state` column keeps a legacy-blob mirror for 30 days
  after the split migration (ADR-0088's 2026-10-14 addendum) so an old,
  pre-per-store relay binary run against this database still sees real
  rooms — the new binary itself never reads it. Throttle
  buckets stay in memory deliberately: rate-limit state is ephemeral by
  design, and persisting it would make a restart BOTH a pardon and a
  weapon.
