# AGENTS.md — Guide for AI Agents working on Mealime Planner

Offline-first Vue 3 SPA for the frozen Mealime recipe catalog (2,759 recipes
+ images baked into the repo). **No runtime requests to any `mealime.com`
host** — this is enforced by e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`); never add a fetch to external hosts.

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript + Tailwind CSS v4
- Pinia + `pinia-plugin-persistedstate` (keys: `mealime-planner:v1:*`)
- vue-router 4: `/`, `/plan`, `/grocery`, `/history`, `/settings`, `/shop`, `/recipe/:id`, `/cooking/:id` — five bottom tabs (Recipes, Plan, Grocery, History, Settings). All five keep visible labels: the fit was measured at Pixel 7 (82px/tab, widest label 49px, no overflow) and is pinned by e2e, so a 6th tab needs a re-measure (ADR-0016).
- MiniSearch (search), `@vueuse/core` (`useDark`, `useClipboard({ legacy: true })`),
  `lucide-vue-next` (icons, bundled — ADR-0029)
- WebSocket relay (`server/relay.ts` over the shared TS core in
  `server/relay-core/` — ADR-0040; zero-dep Bun-native WebSocket)
  for live room sync
- Bun 1.x toolchain (`bun.lock`); docker bases `oven/bun:1-alpine`
  (build) + `nginx:alpine` (serve); **never pin a major** on base
  images or actions

## Commands

```bash
bun install                    # install deps (bun.lock is the lockfile)
bun run dev                    # dev server (proxies /ws → localhost:8081)
bun server/relay.ts             # relay for dev
bun run build                  # type-check + production build — MUST be green
bun run test:unit              # bun-test unit specs for src/lib (scoped to src)
bunx playwright test           # full e2e suite (starts its own relay)
bunx playwright test e2e/x.spec.ts   # single spec
docker compose up -d --build   # web (nginx, :8097) + relay behind /ws
```

## Docker packaging (ADR-0025)

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

## Cloudflare (hosted path, ADR-0038)

The same app ships two ways: the Docker compose stack above (self-host) and
two Cloudflare Workers (hosted). The hosted path is the SAME relay protocol
spoken by a Durable Object instead of a Bun process.

| | config | worker | domain |
| --- | --- | --- | --- |
| web | `wrangler.jsonc` (root) | none — assets-only (`dist/`, SPA fallback) | `flambette.app` |
| relay | `server/wrangler.jsonc` | `server/worker/index.ts` + `Room` DO | `ws.flambette.app` |

- Commands: `bun run deploy:web`, `bun run deploy:relay`, `bun run dev:relay`
  (workerd locally, :8787), `bun run test:worker` (vitest-pool-workers),
  `bun run types:worker` (regenerates `server/worker-configuration.d.ts`),
  `bun run typecheck:worker`, `bun run typecheck:relay` (the Bun adapter).
  `bunx wrangler deploy --dry-run` on BOTH configs
  is the worker-side gate before any push.
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
  assert. ICON COLOUR is a semantic decision, not a style choice
  (ADR-0036): render a role through `<HueIcon role="…">`, which pulls
  glyph, accessible name and class from the single registry in
  `src/lib/palette.ts` — categorical hues for ingredient TYPE
  (`meat`/`hue-meat`, `fish`/`hue-fish`, `vegetarian`/`hue-vegetarian`,
  `vegan`/`hue-vegan`; the two greens have DIFFERENT tokens AND glyphs)
  and semantic hues for NUTRITION (`energy`/`nutrition-energy` on the
  flame, `sodium`/`nutrition-sodium` on the droplet). A hue is the
  icon's IDENTITY, never its state: selected chips are a TINT
  (`primary-tint` + `primary-strong` text, not a filled tomato), so an
  icon keeps its food hue in BOTH states and stays ≥4.5:1 on the tint;
  the only filled-primary element is the Start cooking action. The two
  families never mix, and colour is never the only signal (the label
  stays).
- **Design tokens (DESIGN.md, ADR-0036)**: `DESIGN.md` at the repo root
  is the SINGLE SOURCE OF TRUTH for the visual identity (palette,
  typography, shapes, spacing, components + the prose Overview/Do's &
  Don'ts). Its YAML front-matter is compiled into the `@theme` block of
  `src/style.css`, which is why components consume `bg-brand`,
  `text-hue-fish`, `max-w-app`, … and NEVER a raw hex literal. Add a
  colour to `DESIGN.md` first, mirror it into `@theme`, and verify it on
  BOTH surfaces (light + dark) — `src/lib/palette.test.ts` fails when the
  two files drift. Validate the file itself with
  `npx -y @google/design.md lint DESIGN.md`; its WCAG contrast findings
  must be fixed, not waived. `DESIGN.tokens.json` is the generated DTCG
  export (`npx -y @google/design.md@0.4.0 export --format dtcg
  DESIGN.md`) and is refreshed with the token, never hand-edited.
- **Dark mode is a THEME FLIP, not `dark:` pairs (ADR-0036)**: the `.dark`
  block in `src/style.css` re-points each `--color-*` variable at its dark
  counterpart (surfaces, text, borders, `hue-*` → `*-soft`, `brand-text` →
  `brand-soft`). Write `bg-surface-raised` and it is correct in both
  themes; a component must NOT add a `dark:` utility for a colour the flip
  already covers. The only places a literal dark token belongs are the two
  documented design decisions (the selected-chip tint and the dark action
  text). A new token pair goes in DESIGN.md, `@theme`, AND the `.dark`
  block, with a parity test.
- **One role registry (`src/lib/palette.ts`)**: every food/nutrition icon
  takes its glyph, accessible name and colour from `ICON_ROLES` /
  `ROLE_GLYPHS`; no component keeps its own icon→hue map. Vegetarian and
  vegan are SEPARATE roles (different tokens AND different glyphs) so the
  pair reads apart in monochrome; exclusion diets (`no-pork`, `no-meat`,
  `no-shellfish`) borrow the protein role but keep their explicit wording.
  A role's class name is a literal string in source, because Tailwind scans
  for complete class names.
- **Layout width**: the app shell, header, nav, ShopView and Plan sheets
  are `max-w-app` (fluid, capped at 1100px); cooking keeps the 672px
  `max-w-reading` measure. The recipe grid steps 1/2/3/4 columns at
  <360/360/720/1024 — there is deliberately NO five-column stage. Desktop
  richness is ALWAYS
  `lg:`/`xl:`-gated — mobile padding, tap targets and ADR-0016's
  82px/tab fit never change to serve a desktop. The immersive cooking
  view keeps `max-w-reading` (672px) on purpose: a step read at arm's
  length wants a measure, not a page.
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
  24h of no keepalive AND no state activity; the 7-day idle TTL is a
  redundant backstop refreshed by the SAME signals (keepalive included —
  a connected peer is not an idle room), and either clock firing tells
  the peers `room_expired` and clears their room code so a stale socket
  can never write into, or delete, a room re-created under that code
  (the windows are ADR-0038's, widening ADR-0026). A
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
  throttle budget. The rules live in the shared core
  `server/relay-core/lifecycle.ts` (decision-table tested on every push) —
  the relay's code canonicalisation is the CLIENT's
  `normalizeRoomCode`, re-exported, so it cannot drift.
- **Room codes are three words (ADR-0021)**: the accepted format is the
  UNION — `amber-falcon-lantern` (`WORD_ROOM_CODE_RE`) or a legacy
  `ZZ9ZZZ` (`LEGACY_ROOM_CODE_RE`) — and everything that touches a code
  goes through `normalizeRoomCode()` in `src/lib/roomWords.ts` (forgiving
  in, canonical out; a PARTIAL word code is refused, never coerced).
  Codes are rolled CLIENT-side and the relay refuses a taken one with
  `code_taken` (the client re-rolls; collisions are tolerated by
  design). The relay's `normalizeCode` is GONE —
  `server/relay-core/codes.ts` re-exports the client's `normalizeRoomCode`,
  so there is one canonicaliser.
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
  store (STORE_SLICES registered). The counter advances at TWO points
  (ADR-0033): on every successful apply, and synchronously at the START
  of a press iff `pendingPlan` is already set — so a **Regenerate** press
  always rolls the seed (the first press reads "Generate" and has no
  earlier pack to differ from, which is what keeps generation 0 = the
  pinned default). `nextAutoPlanGeneration()` PEEKS and must never advance;
  `confirmAutoPlan` only bumps, so a pack previewed at generation N lands
  as shown. e2e pins the v2 default 4-pack
  `[17452, 6389, 9889, 6167]` — any catalog or scoring change breaks those
  pins loudly. The dialog's confirm step PREVIEWS the pack (image +
  title per meal, `data-test="auto-plan-preview"`, resolved through
  `imageSrc`/`onImgError` like every other tile) before anything is
  applied; undo restores the exact prior plan (entries + cleared map) in
  BOTH modes.
- **Nutrition**: `meta.calories`/`sodium_mg` are PER-SERVING — never scale
  them by servings; only totals scale.
- **Share/rooms**: **rooms are the ONLY way to share a plan** (ADR-0051
  retired the one-time `?p=` gzip+base64url link; `src/lib/share.ts` and its
  spec are deleted, and an old `?p=` link now toasts "One-time plan links were
  removed" and has its param stripped — the decoder is GONE, do not
  reintroduce it). The Plan tab keeps a room-only Share sheet (room link,
  copy, cooked-history toggle, leave); there is no size ceiling, because a
  room link is the same length for any plan. Room sync is whole-state
  last-write-wins keyed by `rev`; shared state = `{plan, customItems,
  checked, cleared, customs, favorites, ratings}` —
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
- **Extras (ADR-0015, superseded in part by ADR-0050)**: a free-form
  add that belongs to no planned meal is an "Extra" and lives in the
  **EXTRA ITEMS** group, which renders FIRST on the Grocery tab (above
  every store section) with the add-row anchored under its header. The
  group header itself stays static (no chevron); the categories below it
  toggle. **Sub-sectioned, never routed** (ADR-0050): BOTH the Grocery tab
  and ShopView render extras through the ONE pure `groupExtras`
  (`src/lib/extraSections.ts`) — STORE_SECTIONS order, `Uncategorized`
  LAST, empty groups omitted — so an extras `Produce` sits in the extras
  group's own sub-section and NEVER joins the recipe-derived `Produce`.
  Never add a second grouping implementation. The per-row category PILL is
  gone (the heading above the row says it); its `data-test` no longer
  exists. `Other`/missing means the `Uncategorized` bucket. Collapse keys
  are namespaced (`extraCollapseKey` / `storeCollapseKey`) because an
  extras `Produce` and a store `Produce` sit side by side. Auto-collapse
  is UNIFORM across every group on both screens, a ONE-item extras
  sub-section included (ADR-0050's addendum reversed ADR-0008's
  manual-only rule: a group reading `N/N` while its neighbour is
  collapsed reads as "not working"). The checked-sink is `sinkChecked`
  (`src/lib/sink.ts`), shared by both surfaces — never re-spell its sort.
- **Extras' checked keys are DERIVED and reconciled (ADR-0050)**: an
  extra's checkbox key is `extra::<lowercased name>`, defined ONCE by
  `extraCheckedKey` (`src/lib/extraCheckedKeys.ts`) — never re-spell it
  in a component or a spec. The `::` delimiter is load-bearing: line keys
  are `${nameKey}||${display}`, so a `custom||` extras prefix would be
  indistinguishable from a line key for an ingredient normalizing to
  `custom`. The key and the extra are two facts that must agree, but
  `customItems` and `checked` travel as SEPARATE payload fields, so any
  peer can send a key with no matching extra. The residue is invisible
  and harmful: it reads "already done", so re-adding that name lands in a
  sub-section the done-map calls COMPLETE and auto-collapse HIDES the new
  row. `reconcileCheckedExtras` (pure, returns `changed`) is called at its
  TWO ingress points — `room.applyRemote` and backup's `checked.json`
  writer (a `?p=` share link was a third; ADR-0051 retired it) — never as
  a watcher on
  `customItems` (that would put the grocery store inside the room-synced
  plan store). It never touches recipe-derived line keys, and it MIGRATES
  live legacy `custom||` keys to the current prefix in
  `persist.afterHydrate`, because a plain RELOAD is the case the three
  ingress points do NOT cover and missing it silently unchecks every
  already-checked extra on the first load after upgrade.
  `GroceryTab.removeExtra` also forgets its own key: that is the
  immediate local path; the reconciler is the backstop for keys arriving
  from outside.
- **Auto-collapse (ADR-0008 + addendum)**: GroceryTab AND ShopView
  collapse a category group on the false→true done transition and
  re-expand on true→false; the header keeps its chevron and `N/N` pill.
  In ShopView the collapse watcher is `flush: 'post'`, so the collapse
  is the LAST step after the checked-sink re-sort. ShopView's extras
  group stays manual-collapse-only.
- **Toasts**: `ui.showToast(message, { actions, duration, onDismiss })`.
  `onDismiss` fires exactly once on every end path (timeout, replacement,
  dismiss) — anything guarded around a toast must reset via `onDismiss`.
- **Dark mode**: the `dark` class on `<html>` (set by `useDark` from
  `@vueuse/core`, system preference default, manual override persisted)
  plus the variable flip described above; components stay theme-agnostic.
- Every interactive element gets an `aria-label`; every view must work in
  dark mode.
- **Clickable affordance**: every clickable surface gets a pointer cursor,
  and it is DESKTOP-ONLY — `src/style.css` wraps the whole rule in
  `@media (hover: hover)` (a pointer is a mouse affordance; on touch the
  affordance is the tap target, and no `cursor: pointer` may ship to a
  phone). The global rule covers `<button>`, `[role=button|checkbox|
  radio|switch|option]`, `[aria-pressed]`, checkboxes/radios, `<select>`,
  and `label[for]` / labels wrapping a checkbox, so new controls need no
  class. Non-semantic surfaces (a card `<article>`, a row `<img>`/`<div>`)
  use the `hovercap:cursor-pointer` utility, which resolves to the same
  media query. Deliberately excluded: full-screen dialog scrims
  (`@click.self`), which are not an affordance; a disabled control gets
  `not-allowed` and is excluded from the pointer selectors; the grocery
  provenance pill stays `cursor-help` (a tooltip target). Change `cursor`
  ONLY — never a tap target, hit area or padding (ADR-0016's Pixel 7 fit is
  e2e-pinned).
- **Design ADRs**: `docs/design/` holds ADR-style decision records, one
  file per decision. **[`docs/design/index.md`](docs/design/index.md) is the
  index** — generated by `scripts/build_adr_index.py`, and the only place
  that lists them. Read it, then skim the records your change touches; they
  encode *why* the architecture is shaped the way it is (offline catalog,
  derived grocery, per-serving nutrition, clear = remove, rooms, Bun). To
  add one, run `python3 scripts/build_adr_index.py --next` for the number
  (never count files — that is how four numbers got used twice), write
  `ADR-NNNN-slug.md`, then `bun run data:adr-index`. A superseding decision
  is a NEW record that flips the old one's Status; never rewrite an accepted
  one in place. **Do not add ADRs to this file** — the index is generated and
  `test:data` fails if the two disagree.

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
| `extract_ingredients.py` | `public/data/ingredients.json` | autocomplete index; census of the catalog PLUS a curated supplemental table (`gluten-free`, `lactose-free`, `dairy-free`, plant milks, everyday staples the recipes never name). A supplemental row is a filler, never an override: rows whose nameKey the catalog already produces are skipped. `--check` exits 1 on a stale/missing artifact; goldens: `scripts/test_extract_ingredients.py` (ADR-0052) |
| `fetch_ciquel.py` | `data/reference/` (gitignored) | dev tool: fetches the ANSES CIQUAL food-composition table (Zenodo 4770202) and diffs it against the index so the supplemental table can be reviewed. NOT consumed by the app; `bun run data:ciquel` prints the shoppable gaps (`uv run --with xlrd` — the English XLS is legacy BIFF8, unparseable by stdlib) |
| `build_pack_index.py` | `public/data/pack_index.json` | planner ingredient footprint (ADR-0024) |
| `verify_pack_index_parity.ts` | — | gates the Python builder against the TS it mirrors |
| `extract_timer_hints.py` | `public/data/recipes/<variantId>.timer.json` | per-recipe timer-hint sidecars for the cooking view's timer suggestions (ADR-0041); goldens: `python3 scripts/test_extract_timer_hints.py` |
| `extract_recipe_types.py` | `public/data/recipe_types.json` | meal-type (occasion) filter table, counted from `variant_meta[].ruleset` (ADR-0043); `--check` fails on a stale artifact; goldens: `python3 scripts/test_extract_recipe_types.py` |
| `build_adr_index.py` | `docs/design/index.md` | the generated ADR index that `AGENTS.md` links; `--check` fails on a stale index, `--next` prints the next free ADR number; goldens: `scripts/test_build_adr_index.py` |
| `sync_catalog.py` | the whole catalog | brings the frozen catalog up to date (docs + webp images + builder_data); incremental, keeps what we already have |

```bash
bun run data:pack     # rebuild pack_index.json
bun run data:verify   # assert Python == src/lib/containers.ts + quantity.ts
bun run data:ingredients  # rebuild ingredients.json (census + supplemental table)
bun run data:adr-index    # rebuild docs/design/index.md (the ADR index)
bun run test:data         # goldens on every committed generated artifact
python3 scripts/extract_ingredients.py --check   # stale-artifact gate (CI)
python3 scripts/build_adr_index.py --check        # stale-index gate (CI)
python3 scripts/build_adr_index.py --next         # next free ADR number
python3 scripts/extract_timer_hints.py   # regen per-recipe .timer.json sidecars (idempotent, deletes stale)
python3 scripts/test_extract_timer_hints.py  # 15 golden extraction cases
python3 scripts/extract_recipe_types.py --check  # stale recipe_types.json gate
```

Catalog refresh (ADR-0043): `python3 scripts/sync_catalog.py` is the ONLY way
the catalog grows. It pulls `get_builder_data` (token read from a FILE —
`../mealime-media/.mealime_token`, never a command line), fetches each recipe
doc from `cdn-recipes.mealime.com/<published_recipe_uuid>.json`, archives raw
truth to `../mealime-media/raw_recipes` + `raw_images`, encodes webp with
Pillow, and MERGES builder_data (existing entries are kept, so pinned
ratings/popularity never move silently). Then re-run the four generators above.

**`public/data/recipes/` holds two kinds of JSON** — the catalog docs
(`<variantId>.json`) AND the ADR-0041 timer sidecars (`<variantId>.timer.json`).
Any script walking the catalog MUST use `recipe_doc_paths()` from
`scripts/catalog_paths.py`; a bare `*.json` glob folds the sidecars in and
silently doubles the pack index.

Timer-hint sidecar rules (ADR-0041): recipes with zero hints omit the file
entirely (an on-demand fetch 404s and shows no suggestion affordance);
re-runs delete stale sidecars first; the extractor's maximum duration and
`src/lib/stepTimer.ts`'s `MAX_TIMER_SECONDS` must stay in lockstep
(both 21,600 s = 6 h) — one is Python, one is TS, so no `data:verify` gate
exists for them; change both together.

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
- All 2,759 recipes are authored `serving_count = 6`; index amounts are at
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
  `ghcr.io/belphemur/flambette` AND `...-relay` (tags `X.Y.Z`, `X.Y`,
  `latest` — the workflow strips the `v` prefix) and deploys the Cloudflare
  hosted path (ADR-0039: `deploy-web` + `deploy-relay` via
  `cloudflare/wrangler-action`; previews of both workers run per PR / main
  from `preview.yml`). The `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` secrets are minted and scoped by
  `scripts/cf_ci_secrets.py` — never hand-paste a token.