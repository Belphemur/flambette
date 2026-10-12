# AGENTS.md — Guide for AI Agents working on Flambette (Mealime Planner)

Offline-first Vue 3 SPA for the frozen Mealime recipe catalog (2,759 recipes
+ images baked into the repo). **No runtime requests to any `mealime.com`
host** — this is enforced by e2e (`blockExternalRequests` +
`expectZeroMealimeRequests`); never add a fetch to external hosts.

This file is the ENTRY POINT. The detailed rules live in the topic files
under [`docs/agents/`](docs/agents/) — read the one matching your change
BEFORE improvising; they encode *why* the architecture is shaped the way it
is, and breaking them fails e2e loudly on purpose.

## Product definition (PRD)

`docs/PRD.md` is the product requirements document: personas, value pillars,
the five surfaces, the design-theme summary and the release roadmap. It is a
LIVING product authority and the umbrella over the full redesign (mobile +
desktop): any change that adds, removes or re-scopes user-facing behaviour
updates the PRD in the SAME change, or files an ADR explaining the divergence —
never leave the two disagreeing silently. DESIGN.md implements the PRD's
design intent with normative tokens; `docs/design/` ADRs record the decisions.
The PRD is NOT an ADR: the generated `docs/design/index.md` does not index it.

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

## Topic files

| File | Read it for |
| --- | --- |
| [`docs/agents/conventions.md`](docs/agents/conventions.md) | the do-not-break conventions: `data-test` selectors, derived grocery, container ceil-merge (ADR-0017), diet chips, quick filters, icons + role registry, DESIGN.md tokens, dark-mode flip, layout widths, toasts, a11y, pointer-cursor rule, how to add a design ADR |
| [`docs/agents/auto-plan.md`](docs/agents/auto-plan.md) | the Auto-Plan generator (ADR-0024 → ADR-0080): waste-first proposals, Choose-your-plan chooser, continuity seed, regenerate-as-queue, the pinned gen-0 pack, ratings/favourites weights |
| [`docs/agents/cooking.md`](docs/agents/cooking.md) | the cooking mode (ADR-0020 → ADR-0081): card composition, "This step uses" checklist, the two-state timer card + one presence predicate, honest suggestions, timer alerts (chime + vibration, device-local Settings) |
| [`docs/agents/rooms-and-sync.md`](docs/agents/rooms-and-sync.md) | household rooms: lifecycle (ADR-0026), three-word codes (ADR-0021), identity/presence (ADR-0063), share link, the room-sync payload + join reconciliation, cooked history (ADR-0032), the STORE_SLICES backup registry (ADR-0013) |
| [`docs/agents/grocery-and-extras.md`](docs/agents/grocery-and-extras.md) | extras grouping (ADR-0015/0050), derived checked keys + reconciliation, auto-collapse, the checked-sink |
| [`docs/agents/e2e.md`](docs/agents/e2e.md) | Playwright rules: offline enforcement, gate discipline (full suite ONCE before the final push, reconciled against `--list`, never `tail -N`), known spec pitfalls |
| [`docs/agents/data-pipeline.md`](docs/agents/data-pipeline.md) | the generated `public/data/*.json` artifacts, their scripts and goldens, catalog refresh, TS↔Python parity rules, timer sidecars |
| [`docs/agents/packaging-and-deploy.md`](docs/agents/packaging-and-deploy.md) | Docker packaging (ADR-0025 — smoke-run in CI, copy by GLOB) and the Cloudflare hosted path (ADR-0038/0039 — relay core, wrangler configs, preview hosts) |
| [`docs/agents/release.md`](docs/agents/release.md) | cutting a release: semver choice, the automated changelog, phantom-tag checks, GHCR verification BEFORE the compose bump |

## Standing rules

- **This file and its topic docs are part of the contract**: a change that
  adds, removes or re-scopes agent-facing behaviour updates the relevant
  topic file in the SAME change. Stale docs are bugs.
- `AGENTS.md` is the entry point only — do not grow it back into a
  monolith; new depth goes into a topic file and gets a row in the table
  above.
- **Design ADRs**: every design decision lives in `docs/design/` — the
  generated [`docs/design/index.md`](docs/design/index.md) is the only
  place that lists them, and `test:data` fails when the index is stale.
  How to add (and supersede) one is in
  [`docs/agents/conventions.md`](docs/agents/conventions.md).
- Git discipline: never `git add -A` at repo root (scrape scripts/raw
  archives are gitignored but sit in the workdir; add files by explicit
  path); NO `Co-Authored-By` trailers, ever; identity comes from git
  config alone.
- **History must never contain the Mealime token (`_BB8sG3…`),
  `user_data.json` PII, or `.pi/` paths. Sweep before pushing.**
- `tsconfig.app.tsbuildinfo` may show as modified after a build — don't
  commit it (`git checkout -- tsconfig.app.tsbuildinfo`).
- Secure-context-only APIs (`navigator.clipboard`, `navigator.share`) do
  not exist on plain-HTTP LAN origins. Clipboard goes through
  `useClipboard({ legacy: true })`; never assume Web Share in tests.
- No new runtime deps without surfacing the trade-off first.

## Repo skills (.agents/skills/)

Task-level procedures live as SKILL.md files under `.agents/skills/` —
read the one matching the task BEFORE improvising:

- **`.agents/skills/mealime-add-recipe/SKILL.md`** — adding a household
  (user) recipe: artifact entry, CIQUAL-derived nutrition, image norms,
  the gate order, the temperature rule (dual catalog-style pairs
  preferred — `90°C (194°F)`, °F within the 7°C pair tolerance; unsigned
  `90C` is prose the converter ignores), and the display rules
  (authored-servings seed, humanized rounding, one seasoning-aware
  scaler). ADR-0054 is its design record.

When a procedure is discovered in-session (not derivable from an ADR or
these docs), write it as a new skill there instead of letting it live in
chat history.
