# Mealime Planner

A mobile-first single-page app for browsing the Mealime recipe catalog,
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
  and sorting by rating, popularity, cook time or calories. Full-screen
  detail view with presentation image, macro split, cookware, ingredients and
  instructions, plus a servings stepper that scales quantities.
- **Plan** — add recipes with per-meal serving counts; totals for kcal, cook
  time and meal count. Persisted to `localStorage`.
- **Grocery** — aggregates ingredient line items across the whole plan:
  quantities are parsed and scaled by each meal's serving factor, grouped by
  normalized ingredient name, summed per unit of measure, and bucketed into
  canonical grocery-store sections via a keyword heuristic (fallback:
  "Other"). Checkboxes, progress bar and "clear checked" persist to
  `localStorage`.

Favourites are seeded from the data snapshot and can be toggled per recipe.

## Run it

```bash
npm install
npm run dev     # dev server
npm run build   # type-check + production build into dist/
npm run preview # serve the production build locally
```

## Docker

No volume is needed — the full offline catalog, images and app bundle are
baked into the image.

```bash
docker build -t mealime-planner .
docker run -d -p 8080:80 mealime-planner
# open http://localhost:8080
```

Build is multi-stage (`node:22-alpine` → `nginx:alpine`) with gzip, an SPA
fallback and cache headers (immutable 1y for `/assets/` and `/img/`, no-cache
for `index.html`).

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript
- Tailwind CSS v4 (via `@tailwindcss/vite`), class-based dark mode via
  `useDark` from `@vueuse/core` (system preference by default, manual
  override persisted)
- Vue Router 4 for deep-linkable routes (`/`, `/plan`, `/grocery`,
  `/recipe/:id`, `/cooking/:id`)
- State via Pinia stores in `src/stores/`, persisted to
  localStorage under the `mealime-planner:v1:*` keys
  (`mealime-planner:v1:favourites`, `mealime-planner:v1:plan`,
  `mealime-planner:v1:checked`)
- No runtime dependencies besides Vue, Pinia and MiniSearch (search)

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
