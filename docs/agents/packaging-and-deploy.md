# Packaging and deployment

## Docker (ADR-0025)

- The relay image must stay runnable, not just buildable. The build context
  is the REPO ROOT (ci.yml, release.yml and docker-compose.yml pass
  `-f server/Dockerfile` from there) because `relay-core/codes.ts` re-exports
  `src/lib/roomWords.ts` — the one `src/` import ADR-0040 allows. The image
  keeps the `/app/server` layout and copies by GLOB — `server/*.ts`,
  `server/relay-core/`, `src/lib/` — **never enumerate the relay's modules
  one by one**. A hand-picked `COPY` list meant adding `throttle.mjs` shipped
  an image that crash-looped on `Cannot find module './throttle.mjs'`
  (issue #6), and naming `roomWords.ts` alone re-created the same failure one
  level up.
- CI's `docker` job **smoke-runs** the relay image and requires an HTTP 200
  within 30s (dumping container logs on failure). A green `docker build`
  proves the image assembles, never that the entrypoint starts — do not weaken
  that step back to a bare build.
- When you add a relay module, no packaging change should be needed. If you
  ever find yourself editing `server/Dockerfile` to add a filename, that is the
  bug, not the fix.
- `docker compose up -d --build` runs the stack locally (web on :8097, relay
  behind `/ws`); the compose default pulls RELEASED images (`image:` lines,
  build lines commented) — bump both tags together AFTER the images are
  verified on GHCR (see release.md).

## Cloudflare hosted path (ADR-0038/ADR-0039)

The same app ships two ways: the Docker compose stack (self-host) and two
Cloudflare Workers (hosted). The hosted path is the SAME relay protocol
spoken by a Durable Object instead of a Bun process.

| | config | worker | domain |
| --- | --- | --- | --- |
| web | `wrangler.jsonc` (root) | none — assets-only (`dist/`, SPA fallback) | `flambette.app` |
| relay | `server/wrangler.jsonc` | `server/worker/index.ts` + `Room` DO | `ws.flambette.app` |

- Commands: `bun run deploy:web`, `bun run deploy:relay`, `bun run dev:relay`
  (workerd locally, :8787), `bun run test:worker` (vitest-pool-workers),
  `bun run types:worker` (regenerates `server/worker-configuration.d.ts`),
  `bun run typecheck:worker`, `bun run typecheck:relay` (the Bun adapter).
  `bunx wrangler deploy --dry-run` on BOTH configs is the worker-side gate
  before any push.
- Deploys fire from **GitHub Actions** (ADR-0039): `release.yml` deploys both
  workers on the `v*` tag (alongside the GHCR images); `preview.yml` previews
  BOTH workers per PR / main push on preview-only hosts
  (`pr-<N>.{app,relay}.dev.flambette.app`, auto-destroyed when the PR
  closes). The `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets are
  minted and scoped by `scripts/cf_ci_secrets.py` — never hand-paste a
  token, and never add a second deploy path.
- **The hosted web build MUST set `VITE_RELAY_WS_URL=wss://ws.flambette.app/ws`**
  (ADR-0038 §5): the web worker is assets-only, so there is no `/ws` on
  `flambette.app` to dial — without the variable the hosted app would try to
  open a room against its own origin. The override is a BUILD-TIME value (it is
  baked into the bundle), so it belongs in the deploy command / the dashboard's
  build env — never in the source. A plain `bun run build` (self-host, dev, e2e)
  stays same-origin, which is the default every other surface relies on.
- **Never hand-write `Env`.** `server/worker-configuration.d.ts` is generated
  (`bun run types:worker`) and committed; regenerate it after touching either
  wrangler config.
- Worker TypeScript lives in `server/worker/`; the WHOLE relay semantics —
  protocol types, error taxonomy, TTL policy, throttle arithmetic, code
  canonicalisation — live in the shared TS core `server/relay-core/`
  (ADR-0040), which BOTH adapters import. The core owns DECISIONS and speaks
  in intents (`read`/`write`/`drop`/`readFloor`/`writeFloor`/`dropFloor`);
  it never reads `process.env` or a runtime API — `server/relay.ts` (Bun)
  implements the intents over Maps, `server/worker/room.ts` (DO) over SQL
  tables. A semantics change lands in the core ONCE; the adapters differ in
  the store and nowhere else (the DO keeping its room row after the last
  peer leaves is the one deliberate behavioural difference, ADR-0038 §4).
- Code canonicalisation is IMPORTED from `src/lib/roomWords.ts` in
  `server/relay-core/codes.ts` — the lockstep with the client is structural,
  not a hand-maintained copy. Nothing else in `server/` imports from `src/`.
- The decision table (`server/relay-core/lifecycle.test.ts`, run by
  `bun run test:unit` on every push) pins the lifecycle semantics against a
  pure in-memory store; the runtime suites (`test:worker`, Playwright
  room-lifecycle e2e) pin the deployment-specific parts (hibernation, SQL
  survival, real sockets).
- Rooms persist after the last peer leaves **only on Cloudflare**
  (ADR-0038 §4): the Durable Object's storage survives until the expiry
  clocks fire, while the Bun relay still deletes a room nobody is in.
