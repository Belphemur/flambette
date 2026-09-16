# Mealime relay

An in-memory WebSocket relay for the planner's live room sync. One user
creates a room, everyone with the code joins, and every client pushes its
whole shared state through the relay. The relay stores nothing but the
latest state per room — conflict resolution lives entirely on the client
(last-write-wins keyed by a monotonic `rev`).

Run it directly:

```sh
npm install
npm start          # listens on :8081 (override with PORT)
```

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
| `{"type":"create"}` | `{"type":"created","code":"…6 chars…"}` |
| `{"type":"join","code":"ABC123"}` | `{"type":"joined","code":"ABC123","state":<obj\|null>}` — unknown code ⇒ `{"type":"error","code":"not_found"}` |
| `{"type":"state","rev":<int>,"state":<obj>}` | fan-out to every *other* peer in the room: `{"type":"state","rev":<int>,"state":<obj>,"from":"<peerId>"}` |
| `{"type":"leave"}` (or socket close) | `{"type":"left"}` |

Room codes are 6 characters from a Crockford base32 alphabet with all
vowels removed (`0123456789BCDFGHJKLMNPQRSTVWXZ`), uppercase.

## Semantics

- **State**: the relay validates only that `state` is a JSON object and
  `rev` a finite number. It stores the latest pair per room and fans out.
- **Expiry**: rooms expire 12h after their last interaction. The last peer
  leaving does *not* clear the state — a peer can rejoin until expiry.
- **Liveness**: heartbeat ping/pong every 30s; a socket that misses a pong
  is terminated and removed from its room.
- **Persistence**: none. Restarting the relay empties all rooms; clients
  re-create/re-join via their reconnect logic.
