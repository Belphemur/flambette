# ADR-0048 — SPA SEO: Unhead on the client, prerendered recipe heads at build

## Status

Proposed (implemented by supervised pi phase; owner review pending).

## Date

2026-10-03

## Context

Flambette is an offline-first SPA with **no SSR and no runtime server**: the
whole app is a static bundle plus a committed catalog (ADR-0001), shipped by
nginx (Docker), by Cloudflare Workers static assets (ADR-0038) and by a
`?room=` WebSocket relay for household sync only. There is no HTML that
depends on a request, so `dist/index.html` is one static file that every
route is served — which is exactly the situation search engines handle
worst: a crawler with no JS engine reads an empty `<div id="app">`, a
`<title>` that says nothing, and no structured data at all.

The catalog makes an SEO surface genuinely worth having: 2,759 recipes, each
with a name, a meal occasion (`ruleset`), cooking minutes, a full authored
ingredient list, authored steps, per-serving nutrition, a Bayesian-smoothed
rating and real images — all already on disk as committed JSON. Everything a
`schema.org/Recipe` object wants is already published; nothing has to be
invented.

The owner's requirement is explicit: **SEO without spam**. Every string must
derive from the frozen catalog, only recipes are the indexable surface, and
JSON-LD carries only published fields. A recipe page that says "delicious
easy 30-minute family favourite" when the catalog says "30 minutes, 14
ingredients, serving 6" is worse than no page at all: it is the thing
structured-data policy penalises, and it is a lie the app itself never makes.

Two facts shape the design:

1. A head that is written once at build time and a head that is written by
   the running app are two implementations of the same strings. They will
   drift, and the drift is invisible until a crawler disagrees with a browser.
2. The app body is Vue-rendered from reactive state (plan, rooms, dark mode,
   favourites). Prerendering the body would mean re-implementing
   `RecipeDetail` in a string builder — a second rendering path that drifts
   from the first on every design change.

## Decision

### 1. One source, two consumers

`src/lib/seo.ts` is the ONLY place a head string is written. It is pure (no
Vue, no Pinia, no I/O) and exports `isoDuration`, `recipeUrl`,
`recipeImages`, `recipeTitle`, `recipeDescription`, `recipeJsonLd`,
`recipeSeoHead` and `homeSeoHead`, each returning data — never markup. The
two consumers are:

| Consumer | How it consumes the payload |
| --- | --- |
| `src/App.vue`, `src/components/RecipeDetail.vue` | `useHead(recipeSeoHead(doc, meta))` — `@unhead/vue` owns `document.head` |
| `scripts/generate-recipe-seo.ts` (build step) | `src/lib/seoRender.ts` serializes the same payload into static HTML |

The payload's tag shapes (`SeoMetaTag`, `SeoLinkTag`, `SeoJsonLdScript`) are
narrowed to exactly what Unhead's own tag types accept — `rel: 'canonical'`
as a literal, `SeoMetaTag` as a union of the name-based and property-based
arms — so `useHead(...)` type-checks with no cast and a future Unhead upgrade
that breaks the shape breaks the build rather than the SEO.

### 2. The async doc degrades the head, it does not block it

A recipe doc (~20 KB) is fetched asynchronously, but every meta-derived field
— name, description, duration, yield, image, nutrition, rating — is already
known from `builder_data.json` the moment the route resolves. `recipeJsonLd`
and `recipeSeoHead` therefore take a **nullable** doc and return the same
node minus the two doc-only keys (`recipeIngredient`,
`recipeInstructions`). There is no "partial builder" to keep in sync: one
function, and the JSON-LD upgrades itself when the fetch resolves.

### 3. Head-only prerendering, plus a plain `<noscript>` block

`bun run build` becomes `vue-tsc -b && vite build && bun run
scripts/generate-recipe-seo.ts`. The prerenderer walks `feasible_variants`,
reads each `public/data/recipes/<id>.json`, and writes
`dist/recipe/<id>/index.html`: the built `index.html` with its static
`<title>` **replaced** (two `<title>` elements is the exact ambiguity this
feature exists to remove) and the SEO block injected before `</head>`, plus
a `<noscript>` body block after `<div id="app"></div>` carrying the h1, the
description sentence, the hero image, the authored ingredient list and steps
and one link.

`<div id="app">` stays EMPTY on purpose: hydration must never fight a stale
DOM. The `<noscript>` block is deliberately plain — a second copy of
`RecipeDetail`'s markup would be a rendering path guaranteed to drift.

Serialization lives in `src/lib/seoRender.ts`, not in `scripts/`, because
`bun run test:unit` globs `src` (and `tsconfig.app.json` type-checks only
`src`) — a helper that lives in `scripts/` would be the one piece of this
feature with no test and no type coverage. The script itself is a thin I/O
shell.

### 4. The step is idempotent, because it rewrites its own input

`dist/index.html` is both the base template AND an output. On a second run
the file on disk already carries a prerendered head; feeding that back in
stacks a second head on the first. `resetPrerenderHead()` strips the block
identified by its generated-file marker immediately after reading, so
re-running the build is byte-identical (verified by hashing `dist/recipe/`).
`dist/recipe/` is deleted first, mirroring the idempotent-delete habit of
`scripts/extract_timer_hints.py`, so a catalog sync that drops a recipe
cannot leave a stale page behind.

### 5. Anti-spam contract (the rules the builders encode)

- **Every string derives from the catalog.** The description is one factual
  sentence assembled from the recipe's own name, occasion label, cooking
  minutes, ingredient count and serving count. No adjective the catalog did
  not publish, no keyword stuffing, no site-name suffix on the title.
- **Images are the LOCAL webp files, never the CDN URLs.** The catalog stores
  `cdn-uploads.mealime.com` URLs; the CDN is going away and "no runtime
  requests to `mealime.com`" is an e2e-enforced rule, so `recipeImages`
  maps through `localImageUrl` and returns absolute local URLs. An imageless
  recipe gets `[]` — no placeholder URL is ever invented, and the OG/Twitter
  image tags are omitted with it.
- **JSON-LD omits what the catalog does not publish:** no `prepTime`, no
  `cuisine`, no `author` person, no `review`. `aggregateRating` appears only
  when `rating > 0 && rating_count > 0` — a smoothed value with a zero count
  is fabricated evidence of a rating nobody gave.
- **Nutrition is per serving** (`meta.calories` / `sodium_mg` are already
  per-serving, ADR-0002), so the JSON-LD states them as the app displays
  them; only totals scale anywhere.
- **Instructions are `HowToStep`s of `primary_message` only** — the
  secondary breakdown lines are ingredient amounts, not prose steps.

### 6. Canonicals and the indexable surface

Only `/recipe/:id` pages are the recipe surface, and their canonical is the
absolute recipe URL. Every app-shell route (`/plan`, `/grocery`, `/settings`,
…) is served the SPA fallback, so they all share one head — `homeSeoHead()`,
self-canonical to `https://flambette.app/`. The homepage itself is **not**
`noindex`: the canonical, not a robots directive, is what tells a crawler
that `/plan` served this same document is a duplicate of it. `robots.txt`
allows everything except `/cooking/` (a fullscreen session view) and points
at the sitemap.

Canonicals always point at `SITE_URL` (`https://flambette.app`, overridable
at build time via the `SITE_URL` env var). A self-hosted instance
canonicalizing to the official site is deliberate: a private install must not
compete with the hosted one in search.

### 7. The serving matrix

`dist/recipe/<id>/index.html` is only useful if `/recipe/<id>` reaches it:

| Surface | `/recipe/<id>` | Why |
| --- | --- | --- |
| nginx (Docker, self-host) | prerendered file | `try_files $uri $uri/ /index.html` + `index index.html`: the directory resolves to its index before the fallback |
| Cloudflare static assets (hosted) | prerendered file | an existing directory index is an existing asset; `not_found_handling: "single-page-application"` only fires for paths that do NOT resolve |
| `vite preview` (e2e only) | SPA shell at `/recipe/<id>`, prerendered file at `/recipe/<id>/` | sirv's single-file mode does not resolve a directory index |

Nothing about this matrix is asserted in e2e: `vite preview`'s fallback is a
dev-server detail, and both production surfaces are configured by files this
ADR deliberately does not touch (`nginx.conf`, `wrangler.jsonc`). The e2e
suite therefore proves the app still works when served the shell — which is
the fallback that must keep working anyway.

## Consequences

- A crawler reads the complete truth for all 2,759 recipes without running
  JS; a browser hydrates the same page and Unhead reproduces the same head,
  so the two surfaces cannot disagree.
- `dist/recipe/` adds ~2,759 small HTML files (~17 MB uncompressed). They are
  build output (`dist/` is gitignored) and gzip well, because the body is
  nearly empty and only the `<head>` is real.
- The build gains a step that can fail loudly (a missing `dist/`, a missing
  `</head>`, a feasible variant with no doc file warns and is skipped). It is
  fast (~3 s) and deterministic.
- No new runtime dependency beyond `@unhead/vue`; nothing in `src/` imports
  `scripts/`, and nothing in `server/` is touched.
- The SEO surface can only ever describe what the catalog knows. A future
  catalog field (prep time, cuisine) becomes a builder change plus an ADR
  line — never a hand-written meta tag.

## Alternatives considered

- **SSR / a runtime renderer (Nuxt, Vite SSR):** rejected. The app is
  offline-first with a committed catalog and a WebSocket relay, not a
  request-time data source; SSR would add a server to the Docker and
  Cloudflare paths and to the "no runtime server" design ADR-0038 rests on.
- **A build plugin inside `vite.config.ts` (`closeBundle` + `transformIndexHtml`):**
  rejected. It works, but it hides a data walk and ~200 lines of
  serialization inside the bundler config, outside `vue-tsc` and outside
  `bun test src` — the worst place for the SEO truth to live.
- **Prerendering the whole app body:** rejected. `RecipeDetail` is reactive
  Vue; a string-rendered copy is a second rendering path, and hydration
  against mismatched markup is a bug class rather than a feature.
- **A second `<title>` appended instead of replacing the base one:** rejected
  — two titles is the ambiguity this feature exists to remove; pinned by a
  unit test that counts `<title>` occurrences.
- **`noindex` on the app-shell routes instead of a canonical:** rejected.
  The homepage is a legitimate search result, and `noindex` on the file that
  serves the homepage would de-index it too. The canonical does the
  deduplication without that side effect.
- **Hand-written `<meta>` tags in `index.html` for the shell:** rejected —
  it would be a second copy of the home title/description that drifts from
  `homeSeoHead()`.
- **A sitemap of every route** (`/plan`, `/grocery`, …): rejected. They are
  views of one document and all canonicalize to the homepage, so listing them
  would advertise duplicate content.