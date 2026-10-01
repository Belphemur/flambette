<table>
<tr>
<td width="72px" align="center"><img src="docs/logo/flambette.svg" width="64" alt="Flambette logo — a flame rising off a stacked dinner plate" /></td>
<td><h1>Flambette</h1></td>
</tr>
</table>

<p align="center"><img src="docs/screenshots/hero.webp" width="100%" alt="Flambette — a steaming red Dutch oven of Tuscan chicken and tomato stew beside the app's recipe card" /></p>

<table>
<tr>
<td width="19%" align="center"><img src="docs/screenshots/recipes.png" width="100%" alt="Recipes grid" /><br /><sub><b>Recipes</b> — search, tinted filter chips and a photo-led food grid</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/recipe-detail.png" width="100%" alt="Recipe detail" /><br /><sub><b>Recipe</b> — photo, type icon, filled <i>Start cooking</i> and the nutrition block</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/plan.png" width="100%" alt="Meal plan" /><br /><sub><b>Plan</b> — meal rows with servings, live totals and the Auto-Plan route</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/grocery.png" width="100%" alt="Grocery list" /><br /><sub><b>Grocery</b> — store sections, scaled quantities and provenance pills</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/cooking.png" width="100%" alt="Cooking mode" /><br /><sub><b>Cooking</b> — one step at a time on a 672px reading measure</sub></td>
</tr>
<tr>
<td width="19%" align="center"><img src="docs/screenshots/recipes-dark.png" width="100%" alt="Recipes grid, dark mode" /><br /><sub>Espresso surfaces, soft food hues</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/recipe-detail-dark.png" width="100%" alt="Recipe detail, dark mode" /><br /><sub>The same tomato action, now keyed for espresso</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/plan-dark.png" width="100%" alt="Meal plan, dark mode" /><br /><sub>Warm-on-dark, no unstyled light surface</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/grocery-dark.png" width="100%" alt="Grocery list, dark mode" /><br /><sub>Quantities stay legible in both themes</sub></td>
<td width="19%" align="center"><img src="docs/screenshots/cooking-dark.png" width="100%" alt="Cooking mode, dark mode" /><br /><sub>Hands-free step reader at the stove</sub></td>
</tr>
</table>

<p align="center"><sub>Every screenshot is captured from the running app
(<code>bun run dev</code>), on the seeded catalog, at 390&times;844 &mdash; light
and dark, from the same build.</sub></p>

A mobile-first single-page app for browsing a frozen recipe catalog (originally scraped from Mealime, whose name this project does not carry),
building a meal plan, and generating a grocery list from it.

Fully offline and fully self-contained: the repo ships the complete recipe
catalog — all 2,730 full recipe documents (`public/data/recipes/`, ~15 MB,
one JSON per variant id) plus the catalog snapshot — **and every recipe
image** (`public/img/recipes/`, one WebP per archived Mealime CDN image).
The app makes **no external requests at runtime**: recipe details are
fetched from the bundled local files, and all imagery (thumbnails,
presentation images, favourites) is served from the local archive via the
naming rule *remote-URL basename with the extension swapped to `.webp`*.
Recipes without an image (or whose local file is missing) fall back to a
neutral placeholder.

## Features

- **Recipes** — browse 2,730 variants in a responsive card grid with search
  (by name or ingredient), category / favourites / cook-time / PRO filters,
  and sorting by rating, popularity, latest, cook time or calories.
  Full-screen detail view with presentation image, macro split, cookware,
  ingredients and instructions, plus a servings stepper that scales
  quantities (per-serving nutrition stays fixed; only totals scale).
- **Diet filters** — chips for no-pork, no-shellfish, no-meat, vegetarian and
  vegan, applied across search, browse and Auto-Plan. The catalog ships no
  diet metadata, so this is a transparent keyword heuristic over each
  recipe's ingredient list: a fast suggestion lens, not a guarantee.
- **Auto-Plan** — complete a week of meals in one tap. A deterministic
  pack builder scores recipes by *marginal package cost* (how many extra
  supermarket packages each pick would force you to buy, counting a
  container as bought whole), weighted against vote-smoothed rating and
  variety, and skips pantry staples you already have. By default it ADDS
  to your current plan and reuses what you're already buying; a meal-type
  selector (Dinner / Breakfast / Dessert / Any) scopes each run. Pick a
  pack size, optionally exclude categories or diets, confirm, and undo if
  you don't like the result. Same inputs always produce the same plan —
  no model, no randomness.
- **Plan** — add recipes with per-meal serving counts; totals for kcal, cook
  time and meal count. Persisted to `localStorage`.
- **Grocery** — aggregates ingredient line items across the whole plan:
  quantities are parsed and scaled by each meal's serving factor, grouped by
  singularized ingredient name (`carrot`/`carrots` merge), summed per
  normalized unit (`2 cloves` + `1 clove` → `3 cloves`), and bucketed into
  canonical grocery-store sections via a keyword heuristic (fallback:
  "Other"). Ingredients shared between several planned meals get a
  "N recipes" badge (hover/focus shows which). Free-form items not in any
  recipe can be added as **Extra items** — they render in their own group at
  the top, tagged with a category pill when one applies. Checkboxes, progress
  bar and "clear checked" persist to `localStorage`.
- **Waste-aware quantities** — container-shaped amounts (`½ (142 g) pkg`,
  `1 small bunch`, `1 head`) are treated as *purchased units* and merged
  with a ceiling, so two recipes sharing a pack of cheese cost one package,
  not two. Spoon/measure amounts stay linear, and seasonings scale
  sub-linearly (doubling a recipe does not double the salt). Recipe and
  cooking-step text is always left exactly as written.
- **Cooking mode** — a full-screen, distraction-free step-by-step view
  (`/cooking/:id`) with one step at a time, per-step scaled ingredients,
  measured-amount chips where a step needs the quantity, progress
  (Step N / M) and keyboard/swipe navigation. Each step can carry its own
  **timer**; a countdown survives a page reload rather than silently
  restarting, and finishing with a timer still running asks first.
- **Cooking history** — what you actually cooked, how often, and when,
  browsable on its own **History** tab with per-recipe stats. Personal by
  default: it is only shared with a room if you explicitly opt in.
- **Live room sync** — the Plan tab can start a *live room*: one person
  creates it, anyone opening `/plan?room=CODE` joins, and every change to the
  plan, custom grocery items, grocery checkmarks and cleared ingredients
  propagates instantly both ways (last-write-wins per revision). Room codes
  are three readable words (`amber-falcon-lantern`), rolled on the client
  and shareable with one tap. A **household room** can be saved in Settings
  and is re-joined automatically on every launch. A status chip shows
  Live / Connecting / Offline; the code is kept for the browser session so
  reloads re-join automatically. The classic one-time `?p=` share link is
  still available for offline sharing.
- **Shopping mode** — a full-screen, big-target checklist of the grocery
  list, optimized for in-store use: one collapsible section per store
  section, large tap rows with big custom checkboxes, checked items fade
  and sink within their section, and a sticky progress bar with an Exit
  button. Finished sections collapse themselves. Entered from the grocery
  tab's "Start shopping" button.
- **Backup & restore** — export everything (plan, checks, favourites,
  settings, cooked history) to a single JSON file and restore it on another
  device. Restore validates the whole file before applying anything, so a
  bad backup can never leave you half-imported.
- **Dark mode** — follows the OS preference on first load; the header
  toggle overrides it and the choice persists.

Favourites are seeded from the data snapshot and can be toggled per recipe.

## Run with Docker Compose (recommended)

`docker-compose.yml` starts two services: **web** (nginx serving the app,
port 8097 on the host) and **relay** (the WebSocket sync service). nginx
proxies `/ws` to the relay, so everything is served from one origin.

```bash
docker compose up -d --build
# open http://localhost:8097
```

Stop with `docker compose down`. The relay keeps room state in memory —
restarting it drops live rooms (plans/checklists live in each browser's
`localStorage` and are never lost). Any client back in afterwards simply
re-establishes the room: `join` creates a code the relay does not know
yet (ADR-0026).

## Run with the published images

Every release publishes both images to GitHub Container Registry, so you can
run the app without cloning or building anything:

```bash
docker compose pull
docker compose up -d
```

Tags follow the release version (`0.11.1`), plus `0.11` and `latest`. Note
that the `v` from the git tag (`v0.11.1`) is **stripped** in the registry —
pull `0.11.1`, not `v0.11.1`.

## Run with plain Docker

No volume is needed — the full offline catalog, images and app bundle are
baked into the image. Running without compose means no live-room sync
(no relay behind `/ws`); everything else works.

```bash
docker build -t flambette .
docker run -d -p 8080:80 flambette
# open http://localhost:8080
```

Build is multi-stage (`oven/bun:1-alpine` → `nginx:alpine`) with gzip, an SPA
fallback and cache headers (immutable 1y for `/assets/` and `/img/`, no-cache
for `index.html`).

## Behind Traefik

Expose **only the `web` service** — Traefik routes `Host` traffic to it and
nginx internally proxies `/ws` to the relay. Add these labels to the `web`
service in your compose file:

```yaml
services:
  web:
    image: ghcr.io/belphemur/flambette:latest
    networks: [traefik, internal]   # internal carries web→relay /ws traffic
    labels:
      - traefik.enable=true
      # Router: match your hostname, terminate TLS
      - traefik.http.routers.mealime.rule=Host(`mealime.example.com`)
      - traefik.http.routers.mealime.entrypoints=websecure
      - traefik.http.routers.mealime.tls.certresolver=le
      # Service: nginx listens on port 80 inside the container
      - traefik.http.services.mealime.loadbalancer.server.port=80
      # Do NOT expose the relay directly — /ws goes through nginx
      - traefik.docker.network=traefik

  relay:
    image: ghcr.io/belphemur/flambette-relay:latest
    networks: [internal]
    # no ports:, no traefik.enable — reachable only from web

networks:
  traefik:
    external: true   # the network your Traefik instance is attached to
  internal:
```

Use `build: .` / `build: ./server` instead of `image:` if you want to run
unreleased code from a checkout.

Replace `mealime.example.com` and `le` with your hostname and certificate
resolver. Serve over **HTTPS**: browsers only expose the native share
sheet (`navigator.share`) and the async clipboard API on secure origins,
so Android's share button appears — and copy-to-clipboard gets its
reliable path — once the app is behind TLS. Plain-HTTP LAN access still
works via the clipboard `execCommand` fallback.

## Development

```bash
bun install
bun run dev                      # dev server (proxies /ws to the relay)
bun server/relay.mjs             # relay on :8081 (dev/e2e)
bun run build                    # type-check + production build into dist/
bun run preview                  # serve the production build locally
bun run test:unit                # unit specs for the pure libs
bunx playwright test             # e2e suite (starts the relay itself)
```

The relay is a zero-dependency Bun service (`server/`, Bun's native
WebSocket API, in-memory only — a room is created by whichever client
arrives first, deleted when its last peer leaves, and expires after 1h
with no keepalive and no activity, 12h idle being the backstop);
`server/README.md` documents the wire protocol.

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript
- Tailwind CSS v4 (via `@tailwindcss/vite`), class-based dark mode via
  `useDark` from `@vueuse/core` (system preference by default, manual
  override persisted)
- Vue Router 4 for deep-linkable routes — five bottom tabs (`/`,
  `/plan`, `/grocery`, `/history`, `/settings`) plus `/shop`,
  `/recipe/:id`, `/cooking/:id`
- State via Pinia stores in `src/stores/`, persisted to
  localStorage under the `mealime-planner:v1:*` keys — the storage key keeps
  the historical name on purpose so existing installs keep their data
  (`mealime-planner:v1:favourites`, `mealime-planner:v1:plan`,
  `mealime-planner:v1:checked`); the live-room code is kept in
  sessionStorage (`mealime-planner:v1` scope, `room` store)
- Bun as the toolchain and runtime (`bun.lock`); Docker base images are
  `oven/bun:1-alpine` (build) and `nginx:alpine` (serve)
- No runtime dependencies besides Vue, Pinia, MiniSearch (search) and
  `@vueuse/core`

## Data provenance

- `public/data/recipes/{variant_id}.json` — the complete offline catalog:
  2,730 full recipe documents (ingredients, line items, scaled instructions,
  cookware, nutrition), one file per variant id in `feasible_variants`.
- `public/data/builder_data.json` — a snapshot of Mealime's recipe-builder
  payload (2,730 feasible recipe variants with metadata, macros, ratings,
  ingredient names and image references).
- `public/img/recipes/` — the offline image archive: one WebP per distinct
  Mealime CDN image (thumbnails at 400px, presentation images at 800px),
  named after the basename of the original remote URL. Resolved at runtime
  by `src/lib/images.ts`.
- `public/data/user_data.json` — reference-only snapshot of a user account
  (used to extract the canonical grocery-store section list and the seed
  favourites; the auth token in it was scrubbed before it entered git).
  Not fetched by the app.
