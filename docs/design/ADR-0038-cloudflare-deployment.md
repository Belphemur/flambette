# ADR-0038: Cloudflare hosts flambette.app — Workers with assets and a Durable Object relay

**Status:** Accepted (2026-10-02).
**Implements:** the direction recorded in [ADR-0027](ADR-0027-preview-hosting-vercel-now-cloudflare-later.md)
§Decision 3 ("Cloudflare is the future full-stack host").
**Extends:** ADR-0006 (room sync over a Bun relay), ADR-0021 (three-word room
codes), ADR-0026 (join-or-create room lifecycle), ADR-0028 (join
reconciliation), ADR-0031 (household favourites + ratings), ADR-0032 (cooked
history shared by default), ADR-0034 (cook anytime / plan identity).

## Context

ADR-0027 left the relay on Bun + Docker on purpose: moving to a managed
platform had to be scoped, not slipped into a preview-hosting change. This ADR
is that scoping.

The hosted deployment moves to Cloudflare under the `flambette.app` zone:

- `flambette.app` — the SPA itself.
- `ws.flambette.app` — the live-room WebSocket relay.

The self-hosted Docker story (ADR-0025: the `web` nginx image + the `relay`
Bun image behind compose) is NOT removed or weakened; it stays the
offline-first, self-hosted path. Cloudflare is the hosted path, deployed from
the repository by the Cloudflare GitHub App (Workers Builds) — no deploy
workflow file and no `CLOUDFLARE_API_TOKEN` secret live in GitHub.

## Decision

### 1. Two Workers on the zone, each from its own wrangler config

| Worker | Config | Serves | Script |
| --- | --- | --- | --- |
| `flambette` | root `wrangler.jsonc` | `flambette.app` | none — assets-only |
| `flambette-relay` | `server/wrangler.jsonc` | `ws.flambette.app` | `server/worker/index.ts` + the `Room` Durable Object |

- The web worker is an **assets-only Worker** (`assets.directory: dist`,
  `not_found_handling: "single-page-application"`), the same
  Workers-with-assets pattern as the SoundSwitch website. It replaces nginx's
  SPA-fallback role on the hosted path; hashed assets keep immutable caching
  via a `_headers` file (the nginx `Cache-Control` rules ported 1:1).
- The relay worker owns all WebSocket traffic. Splitting the two keeps SPA
  deploys from ever touching the stateful relay's code version, and matches
  the two-service shape the compose file already has.

### 2. Room intent moves to the upgrade URL

A Worker cannot hand an already-accepted WebSocket to a Durable Object after
the fact, and routing at upgrade time is what unlocks **WebSocket
hibernation** — a hibernating socket bills no CPU while a household sits on a
1-minute keepalive. The client therefore carries its intent in the connect
URL:

```
GET wss://<relay>/ws?op=create|join&room=<code>
```

`src/stores/room.ts` `connect(role, joinCode)` already knows `role` and the
code before it opens the socket, so this is a URL rewrite, not a state
change. After the upgrade the wire protocol is unchanged: `created` /
`joined` / `code_taken` / `room_expired` / `state` / `keepalive` /
`leave` / `error` messages keep their exact shapes and semantics
(ADR-0021/0026/0028). The `create`/`join` first-message protocol is retired
for the client; the Bun relay keeps accepting BOTH shapes so the message
contract never has a gap.

- `join` on an unknown code stays join-or-create (ADR-0026): the DO for a
  code always "exists" (`idFromName(canonicalCode)`), and the DO answers
  `created` when its storage holds no room, `joined` when it does.
- `create` against a code that already holds a live room answers
  `code_taken` and the client re-rolls (ADR-0021).
- A `create` with no room in the URL (the legacy mint path) is handled by the
  worker entry minting a code before routing.

### 3. The `Room` Durable Object: SQLite storage, alarms, hibernation

One SQLite-backed DO class (`new_sqlite_classes` migration) per canonical
room code:

- **State in storage**: the whole shared snapshot (`rev`, JSON state,
  `createdAt`, `lastActivity`) in a `room` table. The preserve-when-absent
  rule from ADR-0032/0034 carries over verbatim — an inbound snapshot that
  omits `cookedHistory` or `planIdentity` never wipes the stored value;
  `planIdentity: null` is a real answer and replaces.
- **Rev floor in storage**: the per-code `rev` floor (review F4) is just the
  stored `rev`; after an expiry clears the room row, a separate floor row
  `{rev, at}` keeps the household's revision history for the idle TTL, then
  is pruned — the same promise the Bun relay's in-memory `revFloor` map makes.
- **Expiry by DO alarms**, not timers: one alarm scheduled at the earlier of
  the two clocks — 24h without `keepalive` AND without `state` activity, and
  a 7-day idle backstop refreshed by the SAME signals. **This ADR widens
  ADR-0026's clocks (1h / 12h) for BOTH relay backends**: durable storage
  removes the memory pressure the short clocks were sized for, and one
  lifecycle promise should not fork per platform. On fire: push
  `room_expired` to every hibernating socket, close them, clear the room
  row, keep the floor row until its own TTL. `keepalive` is never
  throttled and always refreshes both clocks, exactly as today.
- **Hibernation**: `ctx.acceptWebSocket()` + `webSocketMessage` /
  `webSocketClose` handlers; the peer set is `ctx.getWebSockets()`.
- **Code canonicalisation** is imported from the client (`normalizeRoomCode`
  in `src/lib/roomWords.ts`) so the relay's accepted code shapes can never
  drift from the client's — the same lockstep the Bun relay maintains by
  mirror-and-test, made structural here.

### 4. Rooms survive their last peer on Cloudflare only (scoped deviation from ADR-0026)

ADR-0026 deletes a room the instant its last peer leaves because the Bun
relay is memory-only — "nobody is here" needs no timer. With durable storage
that deletion would discard the household's state for nothing. On the
Cloudflare relay, a room whose last peer leaves KEEPS its stored state until
the ordinary inactivity/idle clocks fire. The client cannot tell the
difference: a returning peer gets `joined` + stored state instead of
`created` + re-seed, and both paths are already handled. The Bun relay is
unchanged; its "delete on last leave" stays correct for a memory backend.

### 5. The client gains a relay base override

`wsUrl()` gains `import.meta.env.VITE_RELAY_WS_URL` (exactly the change
ADR-0027 anticipated). Default stays same-origin `${location.host}${BASE_URL}ws`,
so dev, e2e, LAN and Docker paths are untouched. The Cloudflare build sets it
to `wss://ws.flambette.app/ws`.

### 6. Throttling

Create/join brute-force throttling (qodo 4128519648) lives in the **worker
entry**, not the DO — a per-room object would hand every room its own budget.
The key is `CF-Connecting-IP` (Cloudflare's authoritative client address; no
forwarded-header trust question). Budgets are per-isolate, i.e. per-colo:
household-grade hardening, not an ACL — the same trade-off ADR-0024 records
for the Bun relay's per-IP bucket, with a documented weaker guarantee.
The throttle window/limit logic is reused from `server/throttle.mjs` with the
limit passed explicitly (no `process.env` read at import).

### 7. Toolchain and dependencies (devDependencies only)

- `wrangler` (project-pinned ^4, same as SoundSwitch's `website/`).
- `@cloudflare/workers-types` and generated binding types via `wrangler types`
  — never a hand-written `Env`.
- `vitest` + `@cloudflare/vitest-pool-workers` for DO tests inside workerd —
  the room lifecycle is the most heavily-tested logic in the repo and the DO
  reimplementation must be held to the same bar (join-or-create,
  `code_taken`, preserve-when-absent, rev floor, alarm expiry, hibernation
  fan-out, throttle).
- `compatibility_date` set to the release date; `nodejs_compat` only if a
  imported module genuinely needs it.

### 8. Deployment: Cloudflare GitHub App (Workers Builds), no CI secrets

Deploys are driven by the Cloudflare GitHub App already installed on the
repository — **no `.github/workflows` deploy file and no
`CLOUDFLARE_API_TOKEN`/account-ID secrets**. Both applications are configured
to publish on **tag creation**, in step with the Docker release flow:

- Application `flambette`: repo root, build `bun install --frozen-lockfile &&
  bun run build`, deploy `wrangler deploy` (root `wrangler.jsonc`).
- Application `flambette-relay`: **repo root too** — `server/` has no
  lockfile of its own and the worker imports `src/lib/roomWords.ts` from
  outside it, so a `server/` root cannot build. Install and deploy from the
  repository root: `bun install --frozen-lockfile`, then
  `bun run deploy:relay` (which passes `server/wrangler.jsonc` explicitly).
  The worker needs no build step (wrangler bundles TS itself), and the hosted
  web build sets `VITE_RELAY_WS_URL=wss://ws.flambette.app/ws` — a build-time
  value baked into the bundle, so it belongs in the web application's build
  command / build env (§5), never in the source.
- Pushes to non-production branches get preview versions with preview URLs
  automatically; **production deploys fire on tag creation** (`v<semver>`),
  configured in the Workers Builds settings for each application — the same
  release trigger that ships the GHCR images (ADR-0025), so a release cuts
  both at once.
- First ship sequence: deploy both workers via the authenticated `wrangler`
  CLI, validate on the workers.dev URLs (health JSON, a two-socket room
  round-trip), THEN attach the custom domains — `flambette.app` and
  `ws.flambette.app` are attached by config (`routes` with
  `custom_domain: true`) only after the validation pass, so a botched first
  deploy never takes the hostname down with it.

### 9. Vercel previews stay

ADR-0027 §Decision 1 is untouched: Vercel hosts the SPA previews. With DO
preview versions the relay could eventually join PR previews; that is a
follow-up, not part of this ADR.

## Alternatives considered

- **One combined worker (assets + relay on both hostnames).** Fewer moving
  parts, but every SPA deploy re-rolls the stateful DO code version, the
  assets surface would bleed onto the WS hostname, and the two services
  deploy at different cadences in the Docker world too. Rejected.
- **Literal Cloudflare Pages.** Pages cannot run Durable Objects; Workers
  with assets is the successor product and the pattern this repo already
  uses on SoundSwitch. Rejected.
- **Keep the message-carried protocol, pipe sockets worker↔DO.** Preserves
  the wire protocol byte-for-byte but pays a worker↔DO hop on every message,
  forfeits hibernation, and keeps the 1-minute keepalive billed. The URL
  change is small and the client already knows the intent. Rejected.
- **Third-party broker (Ably/Pusher/PartyKit).** Rejected for the same
  reason ADR-0027 rejected it: it vendors the data path of an offline-first
  app whose relay is a handful of files.

## Consequences

- The relay's strongest testing surface (unit specs) gains a second, more
  capable implementation; `bun run test:unit` keeps covering the Bun side and
  the new vitest pool covers the DO side. Both must stay green.
- The e2e suite keeps running against the local Bun relay through the vite
  proxy — it now exercises the URL-carried protocol on that path. The full
  135×2 suite must pass before merge, as always.
- Room state at rest now lives in Cloudflare storage on the hosted path. It
  is the same household-plan data the client already puts on the wire (and
  in localStorage); nothing new is collected.
- The Docker release path (ADR-0025, `ghcr.io/belphemur/flambette*`) is
  unchanged and stays the smoke-run gate.
- `server/relay.mjs` gains the URL-carried intent alongside the message
  protocol; `AGENTS.md` documents both configs and the new commands
  (`wrangler deploy -c server/wrangler.jsonc`, `wrangler dev -c
  server/wrangler.jsonc`, `wrangler types`).
