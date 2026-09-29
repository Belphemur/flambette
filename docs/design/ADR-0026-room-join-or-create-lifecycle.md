# ADR-0026: A room is created by whoever arrives first, and dies when nobody is there

**Status:** Accepted (2026-09-29)
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
     `state` traffic.
   - *Idle backstop* (12h, `RELAY_IDLE_TTL_MS`): the pre-existing
     long TTL, kept for peers that vanished without a `leave`.
   **Every liveness signal refreshes BOTH clocks, keepalive included.** A
   connected peer that keepalives is, by definition, not an idle room, and
   the 12h backstop must never be the thing that closes a household that
   has been connected all day (this was the CRITICAL review finding:
   refreshing only the 1h clock made a healthy, keepaliving room die at
   12h — and the client treats `room_expired` as terminal, so the
   household was simply gone). With both clocks refreshed by the same
   events, the 12h timer is redundant defence in depth that only matters
   if the 1h path ever breaks: **the promise is "1h of silence closes the
   room"**, and the 12h is the floor under that promise, not a second
   policy. On firing, the room closes and every peer gets
   `{"type":"error","code":"room_expired","reason":"inactive"|"idle"}`.
   The client treats `room_expired` (and `not_found`) as **terminal**: it
   latches a `roomGone` flag that disables the reconnect loop, surfaces
   the message, and forgets the stored code. The decision is pure and
   unit-tested (`src/lib/relayErrors.ts`). It has to be terminal —
   join-or-create means a naive retry would immediately re-establish an
   *empty* room and present that to the household as silent data loss.
   The code itself is kept (not nulled) so the header chip and the
   household toast can still name it; only retrying stops.

5. **A socket belongs to at most one room, and expiry cleans up after
   itself.** `attachPeer` detaches a socket from its previous room before
   putting it in a new one, so a peer can never linger in a room it left —
   which, with the rule below, is what stops a client from being told
   `room_expired` for a room it is no longer in. On expiry the relay
   notifies **only** the sockets whose current `roomCode` still matches the
   expiring room, and it **clears** that code for each of them. A stale
   socket therefore cannot write state into (or `leave`/close and thereby
   delete) a room re-created under the same code by somebody else. `state`
   additionally requires real membership, not just a matching code.

6. **`rev` is monotone per CODE, not per room instance.** Deleting a room
   discards its `rev`, so without help a re-created room restarts at 0: a
   returning member — whose in-memory counter also restarts, on every page
   load — can be handed a stale snapshot as if it were newer, or can seed
   the room at rev 1 while its peers are already past that. The relay
   therefore keeps the highest `rev` a code ever reached (pruned after the
   idle TTL, so it cannot grow without bound) and hands it back in
   `created`/`joined` as `rev`; the client seeds strictly above it and also
   remembers its own high-water mark per code in `sessionStorage`. The
   honesty of the model is unchanged — this is still whole-state
   last-write-wins — but a room that was deleted and re-created can no
   longer be a lower revision pretending to be a newer one.

7. **The client tears down as little as possible.** Two rules, both from
   the review:
   - A frame the relay refused because *it* was malformed
     (`bad_state` / `bad_json` / `unknown_type`) leaves the client **live
     and untouched**. Recycling the socket sent `leave`, and for a
     single-peer room that deleted the very room the client was standing
     in. The pure decision table gained a third answer, `'ignore'`
     (`src/lib/relayErrors.ts`).
   - There is never more than one pending reconnect, and it re-checks the
     `roomGone` latch when it *fires*, not only when it was scheduled: an
     orphaned timer used to be able to resurrect a room the relay had
     already closed. Recycling a socket for a genuine reconnect no longer
     announces a `leave` either — the socket close already detaches us,
     and the re-join re-seeds from our own persisted stores.

8. **The lifecycle rules live in `server/roomLifecycle.mjs`.** Code
   normalization, the room registry, both clocks, the per-code `rev` floor
   and the peer/room bookkeeping are extracted from `relay.mjs` so they
   are unit-testable without a socket — the pattern `server/throttle.mjs`
   already set. The relay keeps its `COPY *.mjs` packaging (ADR-0025), so
   adding a module needed no Dockerfile change. The relay's HTTP health
   response echoes its lifecycle configuration, so a test (or an operator)
   can tell two relays apart without guessing.

## Consequences

- A share link, a `?room=` deep link and the ADR-0019 household auto-join
  all work again after any relay restart, with no host action.
- Rooms are cheap and self-healing; they are also *ephemeral by design*:
  a room whose last peer leaves loses its state — but not its revision
  history, so a re-created room cannot overwrite what the household has
  with something it believes is newer. A household that is entirely
  offline for the length of the idle TTL also loses its state, exactly as
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
- **Refresh only the 1h clock on keepalive** (the first cut of this ADR,
  caught in review). It reads like a refinement and is in fact a trap: the
  12h backstop then becomes the effective lifetime of a *connected* room,
  and because `room_expired` is terminal on the client, a household that
  simply left the app open all day was disconnected with no way back.
