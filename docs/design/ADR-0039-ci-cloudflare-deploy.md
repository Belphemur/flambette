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
   bootstrap file can be deleted afterwards.
2. **Previews (`.github/workflows/preview.yml`, new):** on pull requests and
   pushes to `main`, BOTH workers get a `wrangler preview` deployment
   (`preview --name pr-<PR#>` or `pr-main`; wrangler ≥ 4.136.3 for the
   stable preview URLs). With `gitHubToken` + `deployments: write`, the
   preview URLs surface as GitHub deployments on the PR. Concurrency:
   `preview-<PR# or ref>`, cancel-in-progress. Preview deployments never
   touch the production routes or domains; a preview SPA talks to the
   PRODUCTION relay (`VITE_RELAY_WS_URL=wss://ws.flambette.app/ws`), because
   a preview origin has no relay behind its own `/ws`.

   `wrangler preview` requires a `previews` block in each config, and
   previews do NOT inherit production settings: the assets worker's block is
   empty (`previews: {}` — assets, compatibility settings, migrations and
   placement stay top-level); the relay's restates its vars and placement
   and declares the `ROOM` Durable Object binding, because the worker reads
   `env.ROOM` — without it the preview would 1101. The payoff is ISOLATION:
   each preview automatically gets its own Durable Object namespace and
   storage (the class is same-Worker, no `script_name`), so preview rooms
   can never read or overwrite production rooms.

   **Preview rooms are auto-destroyed when the PR is merged or closed:** a
   `cleanup` job (`pull_request: closed`) deletes the preview for BOTH
   workers (`wrangler preview delete --name pr-<N> --skip-confirmation` —
   preview names are scoped per Worker), and deleting the preview deletes
   its DO namespace with the rooms' storage. The `pull_request` trigger
   therefore lists explicit types including `closed` (closed is not a
   default type), and the preview jobs skip `closed` events.
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
