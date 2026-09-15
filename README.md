# Mealime Planner

A mobile-first single-page app for browsing the Mealime recipe catalog,
building a meal plan, and generating a grocery list from it.

Fully static and offline-first: the recipe catalog ships as a data snapshot,
and full recipe details (ingredients, scaled instructions, cookware) are
lazy-fetched from Mealime's public CDN (`cdn-recipes.mealime.com`, CORS
enabled) and cached in memory. No accounts, no tokens, no live Mealime API
calls from the app.

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

## Stack

- Vue 3 (`<script setup>`) + Vite + TypeScript
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- No router, no state library — plain reactive singletons in `src/stores/`
- No runtime dependencies besides Vue

## Data provenance

- `public/data/builder_data.json` — a snapshot of Mealime's recipe-builder
  payload (2,730 feasible recipe variants with metadata, macros, ratings,
  ingredient names and CDN image/recipe references).
- `public/data/user_data.json` — reference-only snapshot of a user account
  (used to extract the canonical grocery-store section list and the seed
  favourites; the auth token in it was scrubbed before it entered git).
- Full recipe documents are fetched per-view at runtime from
  `https://cdn-recipes.mealime.com/{published_recipe_uuid}.json`.
