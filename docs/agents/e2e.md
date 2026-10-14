# E2E rules (Playwright)

- `blockExternalRequests(page)` + `expectZeroMealimeRequests(page)` on
  every test touching the catalog (offline enforcement — no runtime
  requests to any `mealime.com` host).
- `waitForCatalog` is only valid on the Recipes tab — on Grocery/Plan
  after reload, wait for that tab's own content instead.
- Prefer `focus()` over `hover()` for tooltip assertions (sticky bars
  intercept hover on the Pixel 7 viewport).
- Selectors are `data-test` (NOT data-testid) — Playwright config sets
  `testIdAttribute: 'data-test'`.
- **Build first**: run `bun run build` before a suite — the e2e
  `webServer` serves the LAST-BUILT `dist/`, so a src change is
  invisible to e2e until the build runs. A freshly written spec failing
  with the OLD behaviour is a stale bundle, not a bug.
- **Gate discipline (owner directive)**: per-push gates are
  `bun run build` + `bun run test:unit` ONLY. The full Playwright suite
  runs ONCE — after the LAST code change, immediately BEFORE the final
  push — never between tasks, never per commit. Run it serially (never
  two Playwright suites in one worktree; `webServer` reuses a fixed
  :4173), with output redirected to a file INCLUDING the exit code,
  reconciled (passed + failed + flaky + skipped) against a fresh
  `bun x playwright test --list`. NEVER pipe the suite through
  `tail -N` — the pipe masks the real exit code and truncates the
  summary, and a partial run can read clean. If a late fix lands after
  the suite, re-run only the specs its diff can affect and say which.
  Corollary: once a reconciled full-suite run exists on a tip that is an
  ANCESTOR of what you are about to push, do NOT re-run the suite
  locally — land build + unit, push, and let CI arbitrate.
- Sharded CI is DYNAMIC (`e2e-plan` job in ci.yml): the shard count is
  derived from the actual test count (`playwright test --list
  --reporter=json`, counted per PROJECT) via ceil(tests/100), clamped to
  [2, 10]. Adding a spec file needs no matrix edit — Playwright sharding
  always slices the full list, so no file can silently never run.
- `ERR_CONNECTION_REFUSED` ×N at suite start = stale webServer reuse:
  `rm -rf test-results` and rerun from a clean state; the specs never
  ran, so do not debug them.
- Checkbox pitfalls: the box whose `check()` triggers a collapse
  detaches — use `click()`; clicking checked boxes toggles OFF — loop
  only `:not(:checked)`.
- Standalone Playwright scripts (library API) do NOT read the repo's
  `testIdAttribute` remap — locate elements with explicit
  `[data-test="…"]` CSS selectors.
- When a route's PATH moves, keep its NAME (vue-router callers survive;
  re-pin only path-navigating specs), and mind nav-HIDDEN surfaces (the
  hero `/`): a `gotoTab()` helper times out clicking a nav that does not
  exist there — route directly to the target route instead.
- Test with a fixed ceiling on wall-clock values flakes: assert the
  order-of-magnitude property, not the exact bound.
