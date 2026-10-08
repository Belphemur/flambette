# ADR-0062: Scroll restoration on back-from-recipe

Status: accepted (2026-10-08)

## Context

Browsing the recipes catalog is a scroll-heavy activity: the list renders
batches of cards under an IntersectionObserver sentinel (ADR-0007's lazy
grid), a user scrolls a few screens deep, opens a recipe, reads it, and
goes back. Until now that back navigation always landed at the top of the
list — the user had to re-scroll to find where they were.

Facts that shape the design:

- `src/router.ts` configured `scrollBehavior()` to return
  `{ top: 0 }` unconditionally. vue-router passes a third
  `savedPosition` argument to `scrollBehavior` on POP navigations
  (back/forward) which the old signature discarded.
- The installed vue-router is **5.3.1**. Its `push()` implementation
  writes the LEAVING entry's scroll offset into that entry's history
  state (`scroll: computeScrollPosition()` via a `replaceState` on the
  current entry, immediately before pushing the new one), so the recipes
  list's offset survives in `history.state.scroll` without any app code.
  On pop navigations `handleScroll` recomputes the target's saved
  position — the in-memory map first, falling back to
  `history.state.scroll` — and hands it to `scrollBehavior` as
  `savedPosition`. Because a `scrollBehavior` is configured at all,
  vue-router sets `history.scrollRestoration = 'manual'`, which is what
  stops the BROWSER's own coarse restore from fighting ours.
- The detail view's back button (`RecipeDetail.vue`) calls
  `router.back()` whenever `window.history.state?.back` exists, i.e. for
  every in-app arrival it is a real history POP. Deep links fall back to
  `router.replace('/')`, which is not a pop and stays at the top.
- Restore lands precisely without help because RecipesTab is inside
  `<KeepAlive>` (App.vue) so the cached DOM returns full-height
  immediately, and `RecipeCard` images reserve `aspect-[4/3]`, so nothing
  reflows under the restored viewport. The sentinel may load more cards
  after the restore; they append BELOW the position, which is harmless.

## Decision

1. **`scrollBehavior(to, from, savedPosition)` returns `savedPosition`
   when it is truthy, else `{ top: 0 }`.** That is the whole production
   change. Back and forward navigations restore the exact offset; every
   PUSH navigation — card → detail, header logo (`goHome()`), every tab
   switch — has no saved position and keeps starting at the top. The
   logo's same-page scroll-to-top behavior is unchanged.
2. **No new persisted state.** The scroll rides vue-router's own
   history-state mechanism (`history.state.scroll`), which is per-history
   -entry by construction: it dies with the tab, never crosses devices,
   and needs no store slice, no backup registry entry and no
   persistence migration.
3. **Restore quality is delegated to what already exists** (KeepAlive +
   reserved image aspect ratios). No re-apply mechanism, no scroll
   anchoring code in the app.

### Known limit (accepted)

A back into a NEVER-mounted RecipesTab — a session that started on a deep
link like `/recipe/123` and then goes back to `/` — restores only as far
as the first 60-card batch renders, because there is no cached DOM and no
record of deeper batches. The offset applies, the browser clamps to the
document height at that moment, and the sentinel appends below. Building
a re-apply mechanism (awaiting batch growth and re-scrolling) was
considered and rejected: it adds a moving scroll target for a rare
deep-link-then-back path, and vue-router's saved position is already the
best available answer.

## Consequences

- Back/forward from a recipe detail lands the user where they left the
  list, ±2px, on every viewport (pinned by `e2e/scroll-restore.spec.ts`
  on both Desktop Chrome and Pixel 7).
- Forward navigations (browser forward into a previously visited entry)
  restore too — the same POP path — which matches platform convention.
- The scroll position lives and dies with the history entry: reloading
  the tab, a fresh session or another device all start at the top, which
  is correct for an offline-first single-window app.
- A future change that removes RecipesTab from KeepAlive or lets card
  images reflow the grid will break the ±2px precision; the e2e spec
  pins it loudly if that happens.
