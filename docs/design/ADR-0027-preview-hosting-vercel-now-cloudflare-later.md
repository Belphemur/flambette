# ADR-0027: Vercel hosts previews; Cloudflare is the future full-stack host

**Status:** Accepted (2026-09-29).
**Extends:** ADR-0006 (room sync over a Bun relay), ADR-0025 (images are
smoke-run in CI). No runtime behaviour changes.

## Context

The goal was a per-PR deploy so a human could click a URL and judge the
change before merging. The app is not a pure static site: `server/relay.mjs`
is a stateful Bun WebSocket relay holding every room in memory
(`server/roomLifecycle.mjs`), and the client reaches it at a path on its own
origin — `wsUrl()` in `src/stores/room.ts:82` derives
`wss://<host>/ws` from `location`, with no override and no env var. The
existing deployment story is the one from ADR-0025: two images, `web`
(nginx) and `relay`, behind docker compose.

So the hosting question is really two questions, and conflating them is what
made the first attempt fail. A PR-preview workflow declared
`on: pull_request` was pushed as a branch; the run that fired was a `push`,
matched no trigger, and completed with zero jobs. An earlier Cloudflare
Pages version had the same problem in a different costume: Pages cannot run a
long-lived WebSocket server either.

That prompted an actual check of what Vercel supports, and the answer is
more nuanced than "it doesn't":

- **WebSockets are in beta on all plans**, and **Bun is a first-class runtime**
  with native `Bun.serve()` / `server.upgrade()` support. Fluid compute is
  required, and is the default for projects created after 2025-04-23.
- **Container Images (beta, all plans)** can deploy a `Dockerfile.vercel`
  into the project registry, and `services` + `rewrites` can route a path
  (e.g. `/ws`) at a separate container. This fits the topology we already
  built.
- But a single connection is **pinned to one Function instance**, and the
  docs are explicit that new connections are *not guaranteed* to reach the
  same instance, with the prescribed remedy being an external data store for
  room state. On Hobby, a WebSocket is also capped at **300s**, against a
  relay designed around 1-minute keepalives and a 12h idle TTL.
  There is no documented single-instance pin.

A container or function therefore cannot host the relay *as written* — not
because WebSockets are unsupported, but because a household's two peers can
land on different instances and never see each other, and every connection
dies at 5 minutes regardless.

## Decision

1. **Vercel hosts the SPA previews only.** `vercel.json` pins the Vite preset
   to the repo's own toolchain (`bun install --frozen-lockfile`,
   `bun run build`, output `dist`) and supplies the SPA fallback the
   framework preset does not generate: `vercel build` otherwise routes every
   non-file request to a `/404.html` this app does not have, so `/plan`,
   `/settings` and `/grocery` 404 on a deep link or refresh. The Vercel
   GitHub app auto-deploys every PR, so there is no deploy workflow and no
   `VERCEL_TOKEN` in CI.

2. **A preview is not a room test, and must not be read as one.** Room sync
   needs the Docker host. Previews are for catching UI regressions; the sync
   path is covered by the e2e suite and the ADR-0025 smoke run. A dead `/ws`
   on a preview is expected, not a bug to chase.

3. **Cloudflare is the future full-stack host** if the relay ever moves to a
   managed platform. Durable Objects are the natural fit: one object per room
   gives per-room isolation and a WebSocket server that hibernates instead of
   timing out, which is exactly the in-memory-state problem above. This is a
   direction, not a commitment — no migration is authorised by this ADR, and
   the relay stays on Bun + Docker until someone scopes it properly.

## Alternatives considered

- **A CI deploy workflow (Vercel or Pages) instead of the GitHub app.** The
  app needs no token and no extra moving parts, and gives one preview per PR
  automatically. The first attempt existed only to also capture screenshots,
  which are not wanted; it was deleted rather than repaired.
- **Vercel Functions/Containers for the relay too.** Supported in principle,
  but requires moving room state out of `roomLifecycle.mjs`'s in-memory Maps
  into Redis, plus a client reconnect path, and accepts a 5-minute connection
  churn on Hobby. That is a rewrite of the most heavily-tested file in the
  repo, carrying ADR-0019/0021/0026, for a service that works today. Not
  worth it for previews.
- **A third-party pub/sub broker (Ably, Pusher, PartyKit).** Vercel's own
  docs recommend this for WebSockets, and it would work — but it adds a
  vendor to the data path of a self-hosted, offline-first app whose whole
  point is that the relay is four zero-dependency files.
- **Skip hosted previews entirely and QA on the Docker host.** Free and
  exercises the relay for real, but needs a tunnel and gives no clickable URL
  per PR. Vercel covers the UI cheaply; the relay is covered elsewhere.

## Consequences

- PRs get a clickable preview with working deep links, at no CI cost and with
  no secrets to manage. A `vercel.json` change is now the only way to alter a
  preview's build.
- Room sync is knowingly unexercised on previews. If a change lands that
  looks correct in a preview but breaks sync, the e2e suite is the backstop —
  which means the sync suite must stay green, and cannot be skipped because
  "the preview looked fine".
- `.vercel` and `.env*.local` are gitignored: `vercel link` writes a live
  `VERCEL_OIDC_TOKEN` into the latter, and the former holds project linkage
  that is per-machine.
- If the relay does move to Cloudflare, `wsUrl()` gains a configurable base
  URL — a change that must preserve today's same-origin default so the LAN
  and Docker paths keep working untouched.
