# AGENTS.md — Guide for AI Agents working on Mealime Planner

Offline-first Vue 3 SPA for the frozen Mealime recipe catalog (2,730 recipes
+ images baked into the repo). **No runtime requests to any `mealime.com`
host** — this is enforced by e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`); never add a fetch to external hosts.

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript + Tailwind CSS v4
- Pinia + `pinia-plugin-persistedstate` (keys: `mealime-planner:v1:*`)
- vue-router 4: `/`, `/plan`, `/grocery`, `/history`, `/settings`, `/shop`, `/recipe/:id`, `/cooking/:id` — five bottom tabs (Recipes, Plan, Grocery, History, Settings). All five keep visible labels: the fit was measured at Pixel 7 (82px/tab, widest label 49px, no overflow) and is pinned by e2e, so a 6th tab needs a re-measure (ADR-0016).
- MiniSearch (search), `@vueuse/core` (`useDark`, `useClipboard({ legacy: true })`),
  `lucide-vue-next` (icons, bundled — ADR-0029)
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
- **Quick filters (ADR-0027/0028)**: the WHOLE Recipes-tab filter
  surface is ONE object, `QuickFilters` in `src/lib/quickFilters.ts`
  (`diets`, `protein`, `maxTime`, `sortBy`, `favOnly`, `proOnly`),
  persisted in the existing `mealime-planner:v1:ui` slice. There is no
  "All diets" dropdown and no per-control local ref — the protein slice
  it used to own is a chip (`data-test="protein-chip-*"`), and the diet
  chips keep `data-test="diet-chip-*"` under `data-test="quick-filters"`.
  Every inbound value (backup, room payload) goes through
  `normalizeQuickFilters`, which drops unknown diet ids and defaults
  out-of-range members. The search box is deliberately NOT in the object
  (a search is a question, not a household preference). The control row
  is a 2-column grid on phones so no control can be orphaned on its own
  line (WS1) — keep it a grid, don't reintroduce `ml-auto`.
- **Icons (ADR-0029)**: the icon stack is `lucide-vue-next`, imported
  per component and BUNDLED (no CDN, no icon font — a runtime icon
  fetch fails e2e by design). No glyph characters (`✕ ★ − ✓ ▸ 🛒 …`) and
  no hand-rolled `<svg>` in `src/`; the one exception is the 1×1 recipe
  placeholder data URL in `src/lib/images.ts`. Decorative icons are
  `aria-hidden`; an icon that carries state must also be queryable
  (`aria-label` / `aria-expanded`), because that is what the specs
  assert.
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
  1h of no keepalive AND no state activity; the 12h idle TTL is a
  redundant backstop refreshed by the SAME signals (keepalive included —
  a connected peer is not an idle room), and either clock firing tells
  the peers `room_expired` and clears their room code so a stale socket
  can never write into, or delete, a room re-created under that code. A
  socket belongs to at most one room: join/create detaches it from the
  previous one, so a client that moved on is never notified about the
  room it left. `rev` is monotone per CODE (the floor survives the room
  deletion, pruned at the idle TTL) and is handed back in `created` /
  `joined`, so a re-created room never passes a stale snapshot off as
  newer. The client treats `room_expired`/`not_found` as TERMINAL
  (latched `roomGone`, no reconnect) — re-joining would join-or-create
  an empty room and read as silent household data loss; the pure retry
  decision lives in `src/lib/relayErrors.ts`, whose third answer
  `'ignore'` means "our frame was refused, the room is fine, do
  nothing". Keepalive is NEVER throttled; only create/join spend the
  throttle budget. The rules live in `server/roomLifecycle.mjs` (mirrors
  `throttle.mjs`, unit-tested) — keep the relay's `normalizeCode` in
  step with the client helper.
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
- **Auto-Plan (ADR-0024, v2 = ADR-0027-auto-plan-v2, v3 preference = ADR-0031)**: the plan generator is
  `src/lib/packPlanner.ts` — a PURE lib (no Vue/Pinia/fetch) over the
  committed `public/data/pack_index.json` footprint. Deterministic greedy
  packing, score = marginal whole-package cost (`Σ ceil(container total)`,
  containers per ADR-0017) `+ 0.25·(1−rating) + 0.2·tagOverlap −
  0.05·isFavourite`; seed = rank
  `(generation mod 5)` over the top-5 smoothed-rated candidates (generation
  0 = highest rating); staples in the index's `pantryStaples` are
  present-but-free. Ratings are BAYESIAN-SMOOTHED caller-side (prior
  weight 10, mean over the eligible slice) and tags come from
  `variety_tag_ids` — both injected from `builder_data.variant_meta` (the
  index carries no recipe metadata). Category / diet / ruleset exclusions
  are resolved OUTSIDE the lib by `useAutoPlan` into `excludeIds`. The
  rating SOURCE is layered: the catalog mean is the cold-start floor, and
  the household's own stars (`ratings`) override it for rated recipes —
  see the favourites + ratings bullet. Absent `favoriteIds`/`ratings`
  means v2 arithmetic, bit for bit, which is what keeps the pins valid. DEFAULT
  mode is ADD: the current plan's meals pre-commit as `baseIds` (their
  waste is shared), new meals append; replace keeps the confirm-before-
  destroy flow. The Plan-tab dialog persists `autoPlanRuleset`,
  `autoPlanMode` and the rotating `autoPlanGeneration` counter in the ui
  store (STORE_SLICES registered). e2e pins the v2 default 4-pack
  `[17452, 6389, 9889, 6167]` — any catalog or scoring change breaks those
  pins loudly. The dialog's confirm step PREVIEWS the pack (image +
  title per meal, `data-test="auto-plan-preview"`, resolved through
  `imageSrc`/`onImgError` like every other tile) before anything is
  applied; undo restores the exact prior plan (entries + cleared map) in
  BOTH modes.
- **Nutrition**: `meta.calories`/`sodium_mg` are PER-SERVING — never scale
  them by servings; only totals scale.
- **Share/rooms**: `?p=` is the one-time gzip+base64url export (v1 bare
  arrays still decode). Room sync is whole-state last-write-wins keyed by
  `rev`; shared state = `{plan, customItems, checked, cleared, customs,
  favorites, ratings}` —
  `cleared` is `clearedIngredients` (household state: clearing hides
  ingredients for everyone until re-planned/cooked) and `customs` is the
  remembered custom-ingredient memory (household since 2026-09-27,
  ADR-0012 change note). `favorites` + `ratings` are household
  PREFERENCE (ADR-0031) and are the one deliberate exception to
  whole-state LWW: both are RECORDS carrying `updatedAt` and reconcile
  PER KEY, last writer by timestamp wins. `favorites` records are
  `{favorited, updatedAt}` — tombstones, so an un-star propagates and a
  stale push cannot resurrect it; `ratings` are
  `{rating, count, updatedAt}`. Two peers rating different recipes must
  not clobber each other, and an EQUAL timestamp is not a new opinion.
  Absent field = "don't touch" (never a wipe), both are emitted only when
  non-empty, and there is ONE push writer — `schedulePush(immediate?)`,
  guarded by `applyingRemote`; preference edits pass `immediate` and skip
  the debounce, everything else keeps it.
- **Favourites + ratings (ADR-0031)**: the favourites store seeds from
  the user's own Mealime snapshot on FIRST RUN and is never re-seeded or
  cleared — never change that seeding (`seedFrom` only ADDS, so a peer
  record that landed first is not clobbered). Internally it holds
  `{favorited, updatedAt}` records and MATERIALIZES the public `Set`
  synchronously on every write (never via a watcher — `snapshot()` could
  publish a stale set); the persisted format stays the id array and
  tombstones are in-memory only, so `favourites.json` ships the set.
  `useRatingStore` (`src/stores/rating.ts`) seeds EMPTY:
  `variant_meta.rating` is catalog truth and must NEVER be written into
  a rating. Ratings are 0..5 in 0.5 steps; re-rating from this device
  replaces the value and KEEPS `count` (household size, used for
  smoothing); a peer's newer record rolls the count forward. Auto-Plan
  weights (injected by `useAutoPlan`, the pure lib stays pure):
  household stars override the catalog's Bayesian mean for rated recipes
  (prior weight 1 vs the catalog's 10) and `favoriteIds` pay
  `FAVORITE_BONUS` (0.05) off a candidate's score — a weight only, never
  a command over waste.
- **Cooked history (ADR-0032, supersedes ADR-0011's opt-in)**:
  `cookedHistory` is HOUSEHOLD state by default: the payload carries it
  unless the SENDER has opted out via `shareCookedHistory` (default ON,
  and the opt-out is permanent — `ui.historyShareDefaultMigrated` is the
  one-time default migration marker). Peers apply it with
  `plan.mergeCookedHistory` (a UNION, never a replace: history is
  append-only and every device pushes at once, so a replace would let
  the last writer erase the other phones' cooks). A backup import is the
  one exception and keeps `replaceCookedHistory`. The relay preserves a
  previously stored `cookedHistory` when a snapshot arrives WITHOUT the key
  (an opted-out sender is silent about history, never a wipe), so a later
  joiner still adopts the household's log. The toggle is surfaced
  in Settings → Household sync and the Plan tab's room sheet; changing
  the default again needs a new ADR, not an edit to ADR-0032.
- **Join reconciliation (ADR-0028)**: a `joined` that ADOPTED the
  room's snapshot does NOT push afterwards (the echo re-published a
  possibly stale snapshot at a higher rev and could freeze the household
  on old state); a join that did not adopt (empty room, or the
  `ROOM_REV_KEY` floor rejected the snapshot) still pushes. A local edit
  queued inside the 300ms push debounce outranks a snapshot that arrives
  before its push, and an edit that could not be sent because the socket
  was not live is published on join instead of being silently adopted
  over. New `SharedState` members are OPTIONAL and absence means "don't
  touch", never "wipe".
- **Backup registry (standing rule, ADR-0013)**: every persisted store
  slice MUST be registered in `STORE_SLICES` (src/lib/backup.ts) in the
  same change that adds the store — export, import and validation all
  iterate that single registry. Unregistered slices make every export
  fail loudly (assertRegistryCoverage + e2e registry-coverage case).
  Import is validation-first and atomic: never partial-apply. The
  backup & restore UI lives on the `/settings` tab (ADR-0016) — MOVED
  out of Plan, never duplicated. Registered today: plan + custom items +
  cleared ingredients, cooked history, ingredients, checked, custom
  ingredients, quick filters + settings, `favourites.json` (id array) and
  `ratings.json` (ADR-0031: `{id, rating, count, updatedAt}` rows whose
  import RECONCILES per record, so an older backup cannot roll back a
  newer rating).
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
  amounts, three-word room codes, share-room link, room lifecycle,
  unified quick filters, filter sync + join reconciliation, the Lucide
  icon stack, Auto-Plan preview, household favourites + ratings, cooked
  history shared by default). Skim them before
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