# ADR-0091: Previews create ONE GitHub deployment per PR (web only) and PR close deletes it

**Status:** Accepted (2026-10-15).
**Supersedes:** ADR-0039 §2's GitHub-deployment clause — BOTH preview jobs no
longer post a deployment, and `pull_request: closed` now also deletes the
PR's GitHub deployments. Everything else in ADR-0039 stands (the two-Worker
previews, the preview-only hosts, the base-name rule, the release path).

## Context

ADR-0039 said each preview job "surfaces as its own GitHub deployment" and
envisioned `preview-web-pr-<N>` / `preview-relay-pr-<N>` environments. The
real behaviour (verified in `wrangler-action`'s source) differs in a way that
mattered: the action posts the deployment whenever a `GITHUB_TOKEN` is
configured, and the GitHub `environment` it uses is the wrangler **preview
name verbatim** — `pr-<N>`. So the two jobs posted TWO deployments into ONE
`pr-<N>` environment on every push, and nothing ever removed them: merging
PR #92 (the 34th) left environments `pr-36`…`pr-69` stranded on the
Deployments page. The `cleanup` job deleted only the Cloudflare previews.

The relay preview has no reason to carry a GitHub deployment at all — the
relay URL is plumbing the SPA already points at (the baked
`VITE_RELAY_WS_URL`), not a surface a reviewer visits; the SPA preview is
the one worth a green checkmark and an environment link.

## Decision

1. **Web-only GitHub deployments.** The relay job passes no `gitHubToken`
   (`wrangler-action`'s `createPreviewGitHubDeploymentAndJobSummary`
   early-returns without one — omitting the input is the only switch). The
   web job keeps it, so each PR owns ONE environment (`pr-<N>`, plus the
   persistent `pr-main` for pushes to `main`) with ONE deployment, updated
   by the action on every push to the PR. The workflow-level
   `deployments: write` permission stays.
2. **PR close deletes the GitHub deployments.** The `cleanup` job, after
   deleting both Cloudflare previews, lists the PR's deployments
   (`GET /repos/.../deployments?environment=pr-<N>`), marks each
   `inactive` (GitHub requires a deployment to be inactive before
   deletion), and `DELETE`s each one. With the environment left empty it
   disappears from the Deployments page — the same effect as deleting the
   environment itself. Deleting the ENVIRONMENT object is NOT possible from
   Actions: it needs `administration: write`, a permission the default
   `GITHUB_TOKEN` cannot be granted, so deployment deletion is the mechanism.
3. **The stranded records were swept once** (2026-10-15, ADR cut in the same
   change): all 102 `pr-<N>` deployments (every PR in the range was
   merged/closed), 525 stale `vercel[bot]` deployment records (the
   ADR-0027-era Vercel GitHub App still posts `Production`/`Preview`
   deployments on every push — its uninstall and `vercel.json` removal are a
   separate, still-open decision), and 170 old `pr-main` deployments (latest
   kept) were made inactive and deleted from the live repo.

## Consequences

- The Deployments page stays a live view of OPEN PR previews plus the
  persistent `pr-main`, instead of a PR graveyard.
- A closed PR's environment vanishes on close even if the preview push was
  cancelled — deletion is idempotent and exits cleanly when there is nothing
  to delete.
- Relay preview health stays visible in CI job logs; it no longer appears in
  the Deployments UI. If a reviewer needs the relay URL it is deterministic
  (`pr-<N>.relay.dev.flambette.app`, ADR-0039 §2) and shown in the web
  deployment's built bundle.
