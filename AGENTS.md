# AGENTS.md — Guide for AI Agents working on Mealime Planner

Offline-first Vue 3 SPA for the frozen Mealime recipe catalog (2,730 recipes
+ images baked into the repo). **No runtime requests to any `mealime.com`
host** — this is enforced by e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`); never add a fetch to external hosts.

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript + Tailwind CSS v4
- Pinia + `pinia-plugin-persistedstate` (keys: `mealime-planner:v1:*`)
- vue-router 4: `/`, `/plan`, `/grocery`, `/shop`, `/recipe/:id`, `/cooking/:id`
- MiniSearch (search), `@vueuse/core` (`useDark`, `useClipboard({ legacy: true })`)
- WebSocket relay (`server/relay.mjs`, dep: `ws`) for live room sync

## Commands

```bash
bun install                    # install deps (bun.lock is the lockfile)
bun run dev                    # dev server (proxies /ws → localhost:8081)
bun server/relay.mjs           # relay for dev
bun run build                  # type-check + production build — MUST be green
bunx playwright test           # full e2e suite (starts its own relay)
bunx playwright test e2e/x.spec.ts   # single spec
docker compose up -d --build   # web (nginx, :8097) + relay behind /ws
```

## Conventions (do not break)

- **Test selectors**: components use `data-test="..."`; Playwright config
  sets `testIdAttribute: 'data-test'` (NOT `data-testid`).
- **Grocery list is derived**: from `plan.plan` + `plan.customItems` via
  `src/lib/useGroceryList.ts` / `grocery.ts`. Never duplicate aggregation
  logic in a view. Names merge by singularized key (`nameKey`), units by
  `unitKey` (`2 cloves` + `1 clove` → `3 cloves`).
- **Nutrition**: `meta.calories`/`sodium_mg` are PER-SERVING — never scale
  them by servings; only totals scale.
- **Share/rooms**: `?p=` is the one-time gzip+base64url export (v1 bare
  arrays still decode). Room sync is whole-state last-write-wins keyed by
  `rev`; shared state = `{plan, customItems, checked, cleared}` —
  `cleared` is `clearedIngredients` (household state: clearing hides
  ingredients for everyone until re-planned/cooked).
  `cookedHistory` is personal and must stay out of the room payload.
- **Toasts**: `ui.showToast(message, { actions, duration, onDismiss })`.
  `onDismiss` fires exactly once on every end path (timeout, replacement,
  dismiss) — anything guarded around a toast must reset via `onDismiss`.
- **Dark mode**: Tailwind `dark:` class strategy; `useDark` from
  `@vueuse/core` (system preference default, manual override persisted).
- Every interactive element gets an `aria-label`; every view must work in
  dark mode.

## E2E rules (Playwright)

- `blockExternalRequests(page)` + `expectZeroMealimeRequests(page)` on
  every test touching the catalog (offline enforcement).
- `waitForCatalog` is only valid on the Recipes tab — on Grocery/Plan
  after reload, wait for that tab's own content instead.
- Prefer `focus()` over `hover()` for tooltip assertions (sticky bars
  intercept hover on the Pixel 7 viewport); the grocery provenance pill
  must stay a flex sibling OUTSIDE the truncating name span, else its
  tooltip gets clipped.
- Full suite (72+ tests × 2 projects: Desktop Chrome + Pixel 7) must pass
  before any merge. Run `npm run build` first — vite serve hides some bugs.

## Known pitfalls

- Secure-context-only APIs (`navigator.clipboard`, `navigator.share`) do
  not exist on plain-HTTP LAN origins. Clipboard goes through
  `useClipboard({ legacy: true })`; never assume Web Share in tests.
- `tsconfig.app.tsbuildinfo` may show as modified after a build — don't
  commit it (`git checkout -- tsconfig.app.tsbuildinfo`).
- History must never contain the Mealime token (`_BB8sG3…`), `user_data.json`
  PII, or `.pi/` paths. Sweep before pushing.
- Never `git add -A` at repo root: scrape scripts/raw archives are
  gitignored but sit in the workdir; add files by explicit path.

## Release

- `git tag v<semver>` + push tag → release workflow publishes
  `ghcr.io/belphemur/mealime-planner` AND `...-relay` (tags `X.Y.Z`,
  `X.Y`, `latest` — the workflow strips the `v` prefix).