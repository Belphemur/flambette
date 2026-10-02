# ADR-0039: Cloudflare deploys run from GitHub Actions — previews on PR/main, releases on a tag

**Status:** Accepted (2026-10-02).
**Supersedes:** ADR-0038 §8's deployment *mechanism* (Workers Builds + tag
trigger). The two-Worker architecture, the wrangler configs, the domain
attachment and the first-ship sequence of ADR-0038 all stand. (A
same-numbered draft of this ADR describing a `production` branch model was
written and destroyed with its branch on the same day, never merged.)
**Extends:** ADR-0025 (the Docker/GHCR release flow, unchanged), ADR-0027
(preview hosting), ADR-0038 (the Cloudflare hosted path).

## Context

ADR-0038 §8 wired deploys to the Cloudflare GitHub App's Workers Builds with
production firing on tag creation. That mechanism has two costs: the build
commands and triggers live in the Cloudflare dashboard (unreviewable, outside
the repo's PR flow), and deploys have no concurrency control. The owner chose
the GitHub-Action path instead: the CI logic lives in the repository where it
is reviewed like any other change, and the Cloudflare credential is a minimal
API token minted by a repo script — never an over-scoped personal session and
never a dashboard-generated token pasted into chat.

## Decision

1. **`cloudflare/wrangler-action@v4` deploys.** It reads repo secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Those secrets are
   minted and registered by `scripts/cf_ci_secrets.py`: a ONE-TIME bootstrap
   **account token** (created by the owner in the dashboard with
   `API Tokens: Write` + `Account Settings: Read` + `Zone: Read`, and
   deposited at `~/.config/flambette/cf-bootstrap-token`, never pasted into a
   chat) mints an account-owned token named `flambette-ci (github actions)`
   scoped to exactly what the workflows exercise (`Workers Scripts Write` +
   `Account Settings Read` + the zone groups `Zone Read` / `Workers Routes
   Write`). It is verified functionally and piped to `gh secret set` over
   stdin — the token value is never printed, logged or written to disk.
   wrangler's own OAuth session cannot mint tokens (that right is outside
   its scopes — verified live: HTTP 9109 on the tokens API), so the
   bootstrap is required once. Account-owned tokens accept ONLY
   account-scoped resources (both zone-scoped resource shapes are rejected
   with error 1001), so the zone groups attach to the account and apply to
   its zones. Re-running the script ROLLS the CI token (the previous
   same-named token is deleted after the new secret lands), and the
   bootstrap file must be KEPT for future rotations — wrangler's OAuth
   cannot manage tokens, so a later rotation without it stops at the
   capability check. Rolls are age-guarded (a token created after the run
   started belongs to a concurrent invocation and is not deleted) and walk
   every page of the token list.
2. **Previews (`.github/workflows/preview.yml`, new):** on pull requests and
   pushes to `main`, BOTH workers get a `wrangler preview` deployment
   (`preview --name pr-<PR#>` or `pr-main`; wrangler ≥ 4.136.3 for the
   stable preview URLs), and the two jobs run in PARALLEL — the URLs are
   deterministic, so no job depends on another.

   Preview URLs live on PREVIEW-ONLY hosts under `dev.flambette.app`:
   `<preview-name>.app.dev.flambette.app` for the SPA and
   `<preview-name>.relay.dev.flambette.app` for the relay — routes with
   `custom_domain: true`, `previews_enabled: true` and `enabled: false`, so
   production is DISABLED on those hosts and a preview can never serve a
   production hostname; Cloudflare auto-provisions the wildcard DNS record
   and certificate for each. `preview_urls: true` additionally exposes each
   preview on workers.dev. With `gitHubToken` + `deployments: write`, the
   preview URLs surface as GitHub deployments whose `environment` is stable
   per PR (`preview-web-pr-<N>` / `preview-relay-pr-<N>`) — the SAME two
   deployments are reused on every push instead of multiplying. Concurrency:
   `preview-<PR# or ref>`, cancel-in-progress. Preview deployments never
   touch the production routes or domains.

   The preview SPA talks to ITS OWN preview relay, baked at build time per
   ADR-0038 §5: `VITE_RELAY_WS_URL=wss://pr-<N>.relay.dev.flambette.app/ws`.
   The custom-domain preview URLs are the surface on BOTH workers —
   `pr-<N>.app.dev.flambette.app` for the SPA, `pr-<N>.relay.dev.flambette.app`
   for the relay (verified live: the relay answers its health JSON, the SPA
   serves, both 200).

   **The previews must run under the BASE worker name — no `--env` suffix.**
   The wrangler-action's `environment` input feeds wrangler's `--env`, which
   renames the preview worker (`flambette-preview-web-<env>`), and
   env-suffixed preview workers do NOT bind the custom-domain preview routes
   (verified live: three CI preview runs reported "none are active" for the
   custom domains while a base-name local preview got them immediately). So
   the preview jobs pass no `environment` input; the cost is that the two
   jobs' GitHub deployments share a default environment label instead of
   named per-PR ones — accepted, the URLs matter more.

   `wrangler preview` requires a `previews` block in each config, and
   previews do NOT inherit production settings: the assets worker's block is
   empty (`previews: {}` — assets, compatibility settings, migrations and
   placement stay top-level); the relay's restates its vars and placement
   and declares the `ROOM` Durable Object binding, because the worker reads
   `env.ROOM` — without it the preview would 1101. The relay's per-preview
   `ROOM` DO namespace keeps preview rooms inside the preview's own storage.

   The custom-domain preview routes are TOP-LEVEL config
   (`previews_enabled: true`, `enabled: false`), so they register on the next
   PRODUCTION deploy of each worker — `v1.2.0` (2026-10-02) was that deploy;
   since it, every preview URL resolves on the custom domains. A preview
   created before the routes were registered exposes only its workers.dev
   URL (the "none are active" warning); deleting and re-running the preview
   after the deploy attaches the custom-domain URLs.

   **Preview rooms are auto-destroyed when the PR is merged or closed:** a
   `cleanup` job (`pull_request: closed`) deletes the preview for BOTH
   workers (`wrangler preview delete --name pr-<N> --skip-confirmation` —
   preview names are scoped per Worker), and deleting the preview deletes
   its DO namespace with the rooms' storage. The `pull_request` trigger
   therefore lists explicit types including `closed` (closed is not a
   default type), and the preview jobs skip `closed` events.

   **Bootstrap (done):** the two preview-only custom domains registered on
   the `v1.2.0` production deploy of both workers; the wildcard DNS records
   (`*.app.dev.flambette.app`, `*.relay.dev.flambette.app`, proxied) and the
   wildcard certificate were provisioned by Cloudflare, covering the
   three-label preview hostnames.
3. **Releases (`.github/workflows/release.yml`, updated):** on a `v*` tag the
   existing GHCR docker jobs now run ALONGSIDE `deploy-web` and
   `deploy-relay` (`wrangler deploy` of both workers; the hosted SPA build
   bakes the hosted relay origin per ADR-0038 §5). Concurrency:
   `release-<ref>`, never cancel-in-progress — a release deploy is not
   superseded mid-flight. **Release = merge the PR to `main`, then push the
   tag: the tag ships the images AND the Cloudflare workers at once.**
4. **`ci.yml` gains `ci-<ref>` (cancel-in-progress)** — one push to a ref
   supersedes the previous run for that ref instead of stacking runners.
5. **The app version is a build-time fact.** `vite.config.ts` derives the
   version from git/CI facts and bakes it as the `__APP_VERSION__` define;
   the header renders it (`data-test="app-version"`). A release build shows
   the tag itself (`v1.2.3`); preview and local builds show
   `<latest-tag>-<branch>-<short-sha>`; a checkout without tags degrades to
   `dev-<sha>`. The pure formatter is `src/lib/appVersion.ts` with unit
   coverage. CI builds run `fetch-depth: 0` so the tag is reachable — a
   shallow checkout would silently bake `dev-<sha>`.

## Consequences

- **Deploy logic is reviewed in PRs** like the rest of the repo; the
  Cloudflare dashboard's Workers Builds projects are not used (the GitHub App
  stays installed for wrangler's OAuth identity).
- **The CI token is minimal and rollable**: it can deploy and preview the two
  workers and nothing else; rotating it is re-running one script, and it
  never appears in a chat, log or file.
- **A preview cannot break production**: preview deployments carry their own
  URLs and leave routes/domains untouched.
- The hosted SPA's relay origin is a BUILD-TIME value (ADR-0038 §5), set in
  the workflows' build env — never in source.
