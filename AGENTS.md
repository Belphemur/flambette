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
bun run test:unit              # bun-test unit specs for src/lib (scoped to src)
bunx playwright test           # full e2e suite (starts its own relay)
bunx playwright test e2e/x.spec.ts   # single spec
docker compose up -d --build   # web (nginx, :8097) + relay behind /ws
```

## Docker packaging (ADR-0025)

- The relay image must stay runnable, not just buildable. `server/Dockerfile`
  uses `COPY *.mjs ./` — **never enumerate the relay's modules one by one**.
  A hand-picked `COPY` list meant adding `throttle.mjs` shipped an image that
  crash-looped on `Cannot find module './throttle.mjs'` (issue #6).
- CI's `docker` job **smoke-runs** the relay image and requires an HTTP 200
  within 30s (dumping container logs on failure). A green `docker build`
  proves the image assembles, never that the entrypoint starts — do not weaken
  that step back to a bare build.
- When you add a relay module, no packaging change should be needed. If you
  ever find yourself editing `server/Dockerfile` to add a filename, that is the
  bug, not the fix.

## Conventions (do not break)

- **Test selectors**: components use `data-test="..."`; Playwright config
  sets `testIdAttribute: 'data-test'` (NOT `data-testid`).
- **Grocery list is derived**: from `plan.plan` + `plan.customItems` via
  `src/lib/useGroceryList.ts` / `grocery.ts`. Never duplicate aggregation
  logic in a view. Names merge by singularized key (`nameKey`), units by
  `unitKey` (`2 cloves` + `1 clove` → `3 cloves`).
- **Container units are purchased, not divided (ADR-0017)**: line items
  phrased in purchasable containers (`½ (142 g) pkg`, `1 small bunch`,
  `1 head`) are parsed by `src/lib/containers.ts` and CEIL-merged per
  (container, annotation) — never linearly scaled (spoon/measure units
  keep ADR-0009's linear rule). One meal at its own servings keeps the
  authored text; merges render whole (`1 (142 g) pkg`) or fractional
  (`1 1/2 small bunches`). Grocery display is the only thing that
  changes: recipe/cooking step text stays authentic.
- **Diet chips (ADR-0018)**: `src/lib/dietFilter.ts` is a keyword
  heuristic over `variant_meta.ingredient_names` (the catalog has NO
  diet metadata), token-boundary matched and memoized per variant id.
  Treat its verdicts as a suggestion lens, never a guarantee; the
  keyword tables are the tunable part.
- **Household room (ADR-0019)**: `ui.householdRoom` is a persisted
  default join target; the app auto-joins it after config load unless a
  session resume or `?room=` link already won. Room failures toast and
  never block the UI (retry next launch) — never `await` a room
  operation on a render path. The auto-join is a JOIN, and a join
  creates the room when the relay doesn't know the code (ADR-0026), so a
  relay restart no longer strands the household.
- **Room lifecycle (ADR-0026)**: `join` is join-or-create (first peer
  ESTABLISHES the room, answered `created`; a known room answers
  `joined`); `create` is unchanged and still the host path. A room whose
  LAST peer leaves is deleted immediately (state included) — the peer
  that returns re-joins, which re-creates it. The client sends
  `{type:'keepalive'}` once a minute while live (one interval per
  socket, cleared on every end path) and the relay closes a room after
  1h of no keepalive AND no state activity (12h idle TTL kept as the
  backstop), telling peers `room_expired`. The client treats
  `room_expired`/`not_found` as TERMINAL (latched `roomGone`, no
  reconnect) — re-joining would join-or-create an empty room and read as
  silent household data loss; the pure retry decision lives in
  `src/lib/relayErrors.ts`. Keepalive is NEVER throttled; only
  create/join spend the throttle budget. The rules live in
  `server/roomLifecycle.mjs` (mirrors `throttle.mjs`, unit-tested) —
  keep the relay's `normalizeCode` in step with the client helper.
- **Room codes are three words (ADR-0021)**: the accepted format is the
  UNION — `amber-falcon-lantern` (`WORD_ROOM_CODE_RE`) or a legacy
  `ZZ9ZZZ` (`LEGACY_ROOM_CODE_RE`) — and everything that touches a code
  goes through `normalizeRoomCode()` in `src/lib/roomWords.ts` (forgiving
  in, canonical out; a PARTIAL word code is refused, never coerced).
  Codes are rolled CLIENT-side and the relay refuses a taken one with
  `code_taken` (the client re-rolls; collisions are tolerated by
  design). The relay's `normalizeCode` (in `server/roomLifecycle.mjs`)
  mirrors the client helper — keep them in step.
- **Share room = one tap to the clipboard (ADR-0023)**: use
  `useShareRoomLink()` (`src/composables/useShareRoomLink.ts`), never
  `navigator.share` (no Web Share on plain-HTTP LAN) and never a raw
  clipboard call. It verifies the write by reading back and always says
  something — a share affordance must never fail silently.
- **Step timers (ADR-0020)**: ONE timer per step VIEW (a Meanwhile pair
  is one view, ADR-0010), stored as `{remaining, running, startedAt}` in
  `ui.stepTimers[variantId][viewKey]` — derive the countdown from
  `startedAt`, never re-arm a counter, so a reload mid-cook resumes
  honestly. The countdown NEVER uses the toast surface; minute ticks go
  through `announceCountdown()` in the polite live region only. Finishing
  a cook with a timer running must ask first.
- **Measured amounts under step text (ADR-0022)**: chips come from
  `src/lib/measuredAmounts.ts` — only for detail lines whose own leading
  quantity is unparseable, matched through `nameKey` at word boundaries,
  and scaled by importing the grocery split (`parseContainerQuantity` +
  `containerContribution` + `formatContainerQuantity`; linear/seasoning
  via `scaleQuantity`). NEVER invent a quantity: no line-item match means
  no chip. Step/recipe prose stays verbatim.
- **Auto-Plan (ADR-0024)**: the plan generator is `src/lib/packPlanner.ts` —
  a PURE lib (no Vue/Pinia/fetch) over the committed
  `public/data/pack_index.json` footprint. Deterministic greedy packing,
  score = marginal whole-package cost (`Σ ceil(container total)`, containers
  per ADR-0017) `+ 0.25·(1−rating)`; seed = highest rating (ties → lowest
  id); staples in the index's `pantryStaples` are present-but-free. Category
  / diet / already-planned exclusions are resolved OUTSIDE the lib by
  `useAutoPlan` into `excludeIds`, and ratings come from
  `builder_data.variant_meta` (the index carries no recipe metadata — same
  rule as the pack index bullet in Generated data). UI lives in a Plan-tab
  dialog: confirm before replacing a hand-curated plan, undo toast restores
  the exact previous entries. e2e pins the default 4-pack
  `[4908, 6185, 6729, 12069]` — any catalog or scoring change breaks those
  pins loudly.
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
  settings tab, diet rules, household room, step timers, measured
  amounts, three-word room codes, share-room link). Skim them before
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
- Full suite (135 tests × 2 projects: Desktop Chrome + Pixel 7) must pass
  before any merge. Run `bun run build` first — vite serve hides some
  bugs.

## Generated data (build-time scripts)

`public/data/*.json` artifacts are generated by stdlib-only Python scripts in
`scripts/`, run from the repo root. Re-run only when the frozen catalog
changes; the outputs ARE committed (the app is offline-first, so a missing
artifact is a broken build).

| Script | Output | Purpose |
| --- | --- | --- |
| `extract_ingredients.py` | `public/data/ingredients.json` | autocomplete index (ADR-0012) |
| `build_pack_index.py` | `public/data/pack_index.json` | planner ingredient footprint (ADR-0024) |
| `verify_pack_index_parity.ts` | — | gates the Python builder against the TS it mirrors |

```bash
bun run data:pack     # rebuild pack_index.json
bun run data:verify   # assert Python == src/lib/containers.ts + quantity.ts
```

Parity rules for anything mirroring TS into Python:
- `nameKey` / `unitKey` / `parseQuantity` / `parseContainerQuantity` must stay
  in lockstep with `src/lib/grocery.ts`, `quantity.ts` and `containers.ts`.
  `data:verify` enforces this for the pack index — extend it when you add a
  mirrored helper, and run it before committing either side.
- `pack_index.json` deliberately stores ONLY the ingredient footprint. Recipe
  metadata (name, rating, cooking_minutes, tags) already ships in
  `builder_data.json`; duplicating it doubled the payload for nothing.
- Ingredient nameKeys and unit strings are interned into two string tables
  (338 and 53 distinct values) and referenced by integer. That keeps the file
  at ~540 KB raw / ~73 KB gzip. Measured: brotli-11 saves a further ~8 KB and
  zstd-19 ~15 KB, but neither justifies changing the nginx image for a file
  this small — stock gzip wins.
- All 2,730 recipes are authored `serving_count = 6`; index amounts are at
  the authored servings and scale at read time, never baked.

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