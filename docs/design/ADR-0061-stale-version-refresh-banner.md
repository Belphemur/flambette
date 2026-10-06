# ADR-0061: Stale-version detection and the refresh banner

Status: accepted (2026-10-07)

## Context

A household lives in this app the way it lives in a messaging app: a tab
stays open for days because the room is joined, the plan is on screen, a
step timer may still be running. Deployments (a GHCR image for self-host,
Workers Builds for flambette.app) replace the server's assets, but the
ALREADY-LOADED page keeps executing the old bundle with no signal that
anything changed — the new index.html is `no-cache` in nginx, yet a loaded
page never re-fetches it. A user can finish a cook, re-plan the week and
check off groceries on code two releases old, and only a manual
reload would tell.

Facts that shape the design:

- The version is a BUILD-TIME fact baked as `__APP_VERSION__` (ADR-0039):
  release builds show the tag, everything else shows
  `<tag>-<branch>-<sha>`. Whatever detects staleness must compare the
  running bundle against what is CURRENTLY DEPLOYED, not against a
  registry of releases.
- There is **no service worker** — offline-first here means baked assets,
  so there is no SW update lifecycle to hook and no cache to purge before
  a reload.
- The Cloudflare web worker is assets-only and ports the nginx cache
  rules through the committed `public/_headers` file (ADR-0038 §1);
  `/data/*` there is `max-age=300, must-revalidate`, HTML relies on
  ETag revalidation.
- The app must never make external requests (e2e-enforced), so the
  "what is deployed" answer has to be a same-origin file the deploy
  itself ships.

## Decision

1. **The build emits `dist/version.json`** — `{"version": <the exact
   string baked as `__APP_VERSION__">, "builtAt": <ISO timestamp>}` — via
   a small vite plugin (`generateBundle`) in `vite.config.ts`, computed
   from the SAME `buildAppVersion` facts that define the bundle constant.
   One computation, two consumers: artifact and bundle cannot disagree
   (DRY; a second version formula would drift exactly when it matters).
   In dev, a `configureServer` middleware serves the identical object, so
   local dev and the e2e preview behave like production.

2. **`src/lib/versionCheck.ts` is pure and answers a TRI-STATE question.**
   Fetch `version.json` and compare against the running `appVersion`:

   - `same` — strings equal: nothing to say.
   - `stale` — strings DIFFER: a newer bundle is deployed.
   - `unknown` — fetch failed, timed out, or the JSON did not validate:
     say nothing.

   The comparison is string INEQUALITY, deliberately not semver
   ordering. A deployed change is by definition a new bundle worth
   reloading — a preview deploy (`v2.2.0-feat-x-abc1234` vs
   `v2.2.0-main-def5678`), a same-tag hotfix rebuild and a real version
   bump all compare cleanly as strings, while any semver rule would need
   a convention for suffixes it cannot honestly have. `unknown` never
   nags: a self-hosted user mid-outage must not get a scary banner for a
   check that merely could not run. Unit-tested in
   `src/lib/versionCheck.test.ts`.

3. **The banner is an ASK, never an action taken for the user.** App.vue
   renders, fixed at the top above the sticky header:

   - `data-test="version-banner"` — "A new version of Flambette is
     available";
   - `data-test="version-refresh"` — the only button: performs the hard
     refresh (`location.reload()`). Reload is sufficient BY MECHANISM:
     the new index.html is `no-cache` (nginx) / ETag-revalidated
     (Cloudflare), and it references the new hashed assets, so one
     reload lands the new bundle; with no service worker there is
     nothing else to clear;
   - `data-test="version-banner-dismiss"` — an X that hides it for the
     SESSION ONLY. Dismissal is component state, not a persisted store
     slice (the `STORE_SLICES` registry is untouched); the next page
     load re-checks fresh, so an update cannot be permanently silenced,
     only deferred to a moment the user chooses.

   **Auto-reload is explicitly rejected**: an automatic reload can fire
   mid-cook and destroy the immersive cooking view and a running step
   timer (ADR-0020) to save the user from reading a one-line banner.
   The banner is styled from DESIGN.md tokens (dialog-grade surface, 12px
   control radius, 44px hit targets), theme-flipped for dark mode,
   `role="status"` so it is announced without interrupting.

4. **Check schedule: mount, visibility, and a slow interval.** One check
   after mount; then on every `visibilitychange` → visible (the tab has
   been away; deploys happen while the household does something else);
   then every 5 minutes while open. The fetch runs with
   `cache: 'no-store'` so the app's own verdict never rides a cached
   copy of the version file; listeners are removed on unmount.

5. **Cache headers on the file itself are explicit, on both hosts.**
   nginx gains `location = /version.json { add_header Cache-Control
   "no-cache"; }` (today it would fall into the SPA fallback with no
   header — heuristic caching could serve a stale version silently,
   which is the exact failure this feature detects); the committed
   `public/_headers` gains the matching `/version.json` rule for the
   Cloudflare path. The client's `no-store` fetch makes the app correct
   even where a header is misconfigured; the headers make any other
   consumer correct too.

## Consequences

- Every deploy reaches an open tab within at most ~5 minutes, or the
  moment its household returns to it — and the user, not the app,
  chooses the reload moment.
- The e2e suite is structurally banner-free: the preview server serves a
  `version.json` identical to the bundle's own version, so specs that
  force the banner must intercept `**/version.json` (stale and unknown
  cases) — consistent with the suite's existing route-interception
  helpers.
- The 5-minute interval is a poll, not a push; a user who never leaves
  the tab sees the banner within one interval of a deploy. That bound is
  a deliberate trade against a WebSocket channel for a once-per-deploy
  fact.
- `builtAt` rides along for diagnostics (the banner's tooltip can show
  when the deployed bundle was built) but the comparison uses `version`
  only — two deploys within the same second of a tag build would compare
  equal and are indistinguishable, which is honest: if the version
  string did not change, there is nothing to reload for.

## Alternatives considered

- **Auto-reload on change.** Rejected: destroys mid-cook state and a
  running timer; the banner is the ask, the reload is the user's.
- **A service worker update flow.** The app has no SW by design; adding
  one to gain `updatefound` semantics is its own ADR-scale decision and
  changes the offline model. Rejected for now — `version.json` gets the
  same outcome with one file and one fetch.
- **Semver-ordering comparison.** Needs conventions for
  preview-suffixed versions that no rule can honestly cover; inequality
  is order-free and matches every real deploy shape.
- **Probing `index.html` ETags instead of a version file.** Conflates
  "some asset changed" with "the running version changed" and cannot
  distinguish a preview deploy from production. A first-class version
  file states the fact it carries.
- **Reusing the room WebSocket to push version changes.** The relay is a
  household-data channel, not a deployment-status channel; coupling them
  makes a relay hiccup look like a stale app. Rejected.
