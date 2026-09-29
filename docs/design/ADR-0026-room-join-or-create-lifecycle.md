# ADR-0026: A room is created by whoever arrives first, and dies when nobody is

**Status:** Accepted (2026-10-01)
**Extends:** ADR-0004 (`?room=` deep links), ADR-0006 (rooms), ADR-0019
(household room), ADR-0021 (three-word room codes), ADR-0023 (share-room
link). Changes the `join` semantics of the relay wire protocol and adds one
client message; ADR-0006's last-write-wins whole-state sync is untouched.

## Context

The reported bug: **"I can't ever join/start a room, keep getting room
not found"**, with the wire trace

```
{"type":"join","code":"mauve-peacock-candle"}
{"type":"error","code":"not_found"}
```

`join` was a *lookup*, not a *join* (relay at `810e65d`, `server/relay.mjs`
case `'join'` → `if (!room) { send(ws, {type:'error', code:'not_found'}) }`).
A room existed only between a `create` and the 12h idle TTL that followed
it, in a Map that lives in the relay process's memory and nowhere else
(`const rooms = new Map()`, no persistence, cleared by any restart).

That made the *only* reachable path to a room a `create` from a Plan-tab
share sheet, and made three ordinary situations dead ends:

1. **The household room dies with the relay.** `App.vue`'s
   `autoJoinHousehold()` (ADR-0019) joins the saved `ui.householdRoom` on
   every launch. After a relay restart — a redeploy, a crash, a
   `docker compose restart` — the Map is empty, so the very first frame
   the app sends is the failing one above. The client tore down and showed
   "Room not found — it may have expired", and the retry was *next
   launch*, which failed identically.
2. **Create refuses a live code.** `create` answers `code_taken` for a
   code that exists (so you never silently join a stranger's room), and
   the client re-rolls. So even the host path could not *re-adopt* the
   household code after the relay forgot it: the code was free again, but
   the join path still refused it.
3. **Nobody-is-there was only a timer.** The last peer leaving left the
   room and its state alive until the 12h TTL, so a room nobody is in
   still answered joins.

What the household actually wants is stated plainly: *"a first join
should create the room, and room should be automatically deleted when
nobody is there or very long period of inactivities, client should send
keepalive, if more than 1h without keepalive or actions, close the room
and tell client to disconnect."*

## Decision

1. **`join` is join-or-create.** A `join` for a code the relay does not
   know CREATES the room under exactly that code and answers `created` —
   the same reply shape the host path uses, so the client seeds the room
   with its own state through one code path. An existing room still
   answers `joined` with its current state. `create` is unchanged: it is
   still the host path, still honours a free client-rolled word code and
   still refuses a taken one with `code_taken`. A join with an unusable
   code *shape* (a partial word code — ADR-0021 refuses to coerce it)
   still answers `not_found`.

2. **An empty room is deleted immediately.** The last peer leaving — a
   `leave` or a socket close — drops the room, state included. "Nobody is
   there" is then a fact, not a 12h wait. The return path is honest: the
   peer that comes back re-joins, which re-creates the room, and the
   client re-seeds it from its own (persisted) state on `created`/`joined`.

3. **Application-level keepalive, distinct from the socket ping.**
   `{"type":"keepalive"}` → `{"type":"keepalive_ack"}`. It is *not* the
   30s WebSocket ping: that is transport liveness, it only terminates
   sockets that missed a pong, and it deliberately does not touch room
   activity. The keepalive carries no guessable input and is **never
   throttled** — a liveness frame must not be able to spend the
   create/join budget. The client runs one interval per live socket
   (`KEEPALIVE_MS = 60_000`, one frame a minute) and clears it on every
   end path; a leaked interval would keep a dead room alive forever.

4. **Two expiry clocks, and expiry is announced.**
   - *Inactivity* (1h, `RELAY_INACTIVITY_TTL_MS`): no `keepalive` and no
     `state` traffic. On firing, the room closes and every peer gets
     `{"type":"error","code":"room_expired","reason":"inactive"}`.
   - *Idle backstop* (12h, `RELAY_IDLE_TTL_MS`): the pre-existing
     long TTL, kept for peers that vanished without a `leave`; same
     reply with `reason:"idle"`.
   The client treats `room_expired` (and `not_found`) as **terminal**: it
   latches a `roomGone` flag that disables the reconnect loop, surfaces
   the message, and forgets the stored code. The decision is pure and
   unit-tested (`src/lib/relayErrors.ts`). It has to be terminal —
   join-or-create means a naive retry would immediately re-establish an
   *empty* room and present that to the household as silent data loss.
   The code itself is kept (not nulled) so the header chip and the
   household toast can still name it; only retrying stops.

5. **The lifecycle rules live in `server/roomLifecycle.mjs`.** Code
   normalization, the room registry, both clocks and the peer/room
   bookkeeping are extracted from `relay.mjs` so they are unit-testable
   without a socket — the pattern `server/throttle.mjs` already set. The
   relay keeps its `COPY *.mjs` packaging (ADR-0025), so adding a module
   needed no Dockerfile change.

## Consequences

- A share link, a `?room=` deep link and the ADR-0019 household auto-join
  all work again after any relay restart, with no host action.
- Rooms are cheap and self-healing; they are also *ephemeral by design*:
  a room whose last peer leaves loses its state. A household that is
  entirely offline for the length of a 12h TTL also loses it, exactly as
  before this ADR.
- `not_found` is now rare on the wire: only a malformed code, or a peer
  talking to a pre-ADR-0026 relay. The client keeps handling both codes,
  and a client on an old relay still gets the "expired" message it
  understands.
- The relay is still zero-dependency, still in-memory, still Bun-native.

## Alternatives considered

- **Persist rooms to disk/SQLite** so a restart is invisible. Rejected as
  far out of proportion: it adds a dependency, a schema and a migration
  path to solve a problem that join-or-create already solves for the
  actual failure mode.
- **Keep `join` strict, auto-create only from the client's `create` path**
  (i.e. the client falls back to `create` on `not_found`). Cheaper on the
  wire, but it makes the room's existence depend on a client race, and an
  old client talking to a new relay still dead-ends. The rule belongs on
  the server, where it is testable and uniform.
- **Reuse the 30s socket ping as the keepalive** (no new message). It
  cannot work: the ping is transport-level, and refreshing room activity
  from it would keep a room alive behind a half-open socket, which is
  precisely the case the 1h clock exists for.
- **One TTL (12h) and no keepalive.** It cannot satisfy the ask, and it
  cannot distinguish "idle household" from "broken peer" — the keepalive
  is the signal that makes the shorter window safe.
