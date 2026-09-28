# AGENTS.md — Guide for AI Agents working on Mealime Planner

Offline-first Vue 3 SPA for the frozen Mealime recipe catalog (2,730 recipes
+ images baked into the repo). **No runtime requests to any `mealime.com`
host** — this is enforced by e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`); never add a fetch to external hosts.

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript + Tailwind CSS v4
- Pinia + `pinia-plugin-persistedstate` (keys: `mealime-planner:v1:*`)
- vue-router 4: `/`, `/plan`, `/grocery`, `/history`, `/settings`, `/shop`, `/recipe/:id`, `/cooking/:id` — five bottom tabs (Recipes, Plan, Grocery, History, Settings). All five keep visible labels: the fit was measured at Pixel 7 (82px/tab, widest label 49px, no overflow) and is pinned by e2e, so a 6th tab needs a re-measure (ADR-0016).
- MiniSearch (search), `@vueuse/core` (`useDark`, `useClipboard({ legacy: true })`)
- WebSocket relay (`server/relay.mjs`, zero-dep Bun-native WebSocket)
  for live room sync
- Bun 1.x toolchain (`bun.lock`); docker bases `oven/bun:1-alpine`
  (build) + `nginx:alpine` (serve); **never pin a major** on base
  images or actions

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
  `rev`; shared state = `{plan, customItems, checked, cleared, customs}` —
  `cleared` is `clearedIngredients` (household state: clearing hides
  ingredients for everyone until re-planned/cooked) and `customs` is the
  remembered custom-ingredient memory (household since 2026-09-27,
  ADR-0012 change note).
  `cookedHistory` is personal and must stay out of the room payload
  UNLESS the sender opted in via the `shareCookedHistory` setting
  (default off; ADR-0011 addendum) — then the payload may carry it and
  peers apply it.
- **Backup registry (standing rule, ADR-0013)**: every persisted store
  slice MUST be registered in `STORE_SLICES` (src/lib/backup.ts) in the
  same change that adds the store — export, import and validation all
  iterate that single registry. Unregistered slices make every export
  fail loudly (assertRegistryCoverage + e2e registry-coverage case).
  Import is validation-first and atomic: never partial-apply. The
  backup & restore UI lives on the `/settings` tab (ADR-0016) — MOVED
  out of Plan, never duplicated.
- **Extras (ADR-0015)**: a free-form add that belongs to no planned
  meal is an "Extra" and stays in the static **EXTRA ITEMS** group,
  which renders FIRST on the Grocery tab (above every store section)
  with the add-row anchored under its header. A known category renders
  as a small tag pill (`extra-item-category-tag`) beside the row and is
  NEVER a routing instruction — extras never join a store section, and
  `Other` means "no category", so it renders no tag.
- **Auto-collapse (ADR-0008 + addendum)**: GroceryTab AND ShopView
  collapse a category group on the false→true done transition and
  re-expand on true→false; the header keeps its chevron and `N/N` pill.
  In ShopView the collapse watcher is `flush: 'post'`, so the collapse
  is the LAST step after the checked-sink re-sort. ShopView's extras
  group stays manual-collapse-only.
- **Toasts**: `ui.showToast(message, { actions, duration, onDismiss })`.
  `onDismiss` fires exactly once on every end path (timeout, replacement,
  dismiss) — anything guarded around a toast must reset via `onDismiss`.
- **Dark mode**: Tailwind `dark:` class strategy; `useDark` from
  `@vueuse/core` (system preference default, manual override persisted).
- Every interactive element gets an `aria-label`; every view must work in
  dark mode.
- **Design ADRs**: `docs/design/` holds ADR-style decision records
  (offline catalog, derived grocery, per-serving nutrition, clear
  semantics, rooms, Bun toolchain, auto-collapse, extras pilling,
  settings tab). Skim them before
  proposing changes; new lasting decisions get a new
  `ADR-NNNN-slug.md` (never rewrite an accepted one in place).

## E2E rules (Playwright)

- `blockExternalRequests(page)` + `expectZeroMealimeRequests(page)` on
  every test touching the catalog (offline enforcement).
- `waitForCatalog` is only valid on the Recipes tab — on Grocery/Plan
  after reload, wait for that tab's own content instead.
- Prefer `focus()` over `hover()` for tooltip assertions (sticky bars
  intercept hover on the Pixel 7 viewport); the grocery provenance pill
  must stay a flex sibling OUTSIDE the truncating name span, else its
  tooltip gets clipped.
- Full suite (126 tests × 2 projects: Desktop Chrome + Pixel 7) must pass
  before any merge. Run `bun run build` first — vite serve hides some
  bugs.

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