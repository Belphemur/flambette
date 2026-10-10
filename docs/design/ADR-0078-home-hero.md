# ADR-0078: The home page is a hero page

Status: accepted (2026-10-10)

## Context

`/` has always been the recipes list (`src/router.ts`: `{ path: '/', name:
'recipes', component: RecipesTab }`). A new visitor opening flambette.app
lands straight in a dense recipe grid with no statement of what the app is,
that it needs no account, or that a household can plan together — the two
facts the owner wants impossible to miss.

A hero page for `/` has been designed in Stitch (screen "Flambette — Home
Page Hero", project *Flambette Recipe App*, on the Warm Culinary Paper design
system, token-consistent: tomato `#B3381F` primary, paper-base `#FBF8F2`,
espresso `#211613`, JetBrains Mono room code). The render was verified
against the export HTML: Plus Jakarta Sans + JetBrains Mono only, all copy
verbatim, no invented metrics.

DESIGN.md's Overview currently rejects a "marketing hero" (§ Overview). That
clause was written against inventing fake dashboards and engagement streaks
inside the product surfaces; the owner has now decided the home page IS a
hero page. This record supersedes that clause for `/` only — the Recipes-tab
rule ("No promotional hero above the controls", DESIGN.md § One visual
language) SURVIVES untouched: the hero lives at `/`, never above the recipe
controls.

## Decision

1. **Routes.** A new `HomeView` owns `/` (name `home`). The recipes list
   moves to `/recipes` and KEEPS the route name `recipes` (every
   `router.push({ name: 'recipes' })` — the freshJoin landing watcher, the
   post-join landing, tab targets — keeps working unchanged). `TABS` in
   `src/stores/ui.ts` points the Recipes tab at `/recipes`; the five-tab bar,
   its labels and ADR-0016's measured 82px fit are unchanged.

2. **The hero route has no bottom menu.** Like cooking and shopping, the
   bottom nav is hidden on `/`. The app header stays per the ruling below.

3. **CTAs.**
   - "Start planning" → `router.push({ name: 'recipes' })`.
   - "Create a household" → `room.create()` (the client rolls the three-word
     code, ADR-0021) and opens a modal: the code in JetBrains Mono, a
     "Copy room link" action through `useShareRoomLink()` (ADR-0023's
     verified-write path — never a raw clipboard call), and a primary
     "Browse recipes" action → `/recipes`. A failed create toasts and never
     blocks (the ADR-0019 room-failure pattern).

4. **Copy rules.** The recipe count is the literal constant "2,500+ hand-
   curated recipes" — deliberately NOT the catalog length (owner ruling:
   the number must not claim accuracy). No "offline" wording; "works even
   with no connection" is the accepted phrasing.

5. **Rejected render fictions.** The Stitch screen's own header row with
   tab labels (Recipes/Plan/Grocery/History/Settings) is a desktop-render
   fiction: the real app shell's header (logo + version + room chip + dark
   toggle) is the only header. The sample room code `olive-basin-saffron`
   is a mock value; the modal shows the REAL rolled code.

6. **DESIGN.md.** The Overview clause is amended to name the home hero as
   the one permitted exception, with the hero's token usage recorded there;
   `npx -y @google/design.md lint` must stay at 0 errors / 0 warnings.

7. **The `freshJoin` landing watcher (App.vue) gains `home` in its
   exclusion set** (beside `recipes` and `settings`): a create or join made
   FROM the hero must not navigate away while the household modal is open —
   the modal IS the confirmation surface.

8. **Catch-all** `/:pathMatch(.*)*` keeps redirecting to `/` — unknown URLs
   land on the home page, which is now the hero.

9. **SEO: `/recipes` becomes a real sitemap URL.** Today
   `scripts/generate-recipe-seo.ts` emits only `/` + every `/recipe/<id>`
   (the other app-shell routes are SPA-fallback pages whose canonical is
   `/`, ADR-0048 — that is what keeps them OUT of the sitemap). With the
   recipes list at `/recipes` as its own indexable surface:
   - `src/lib/seo.ts` gains a recipes-list head builder whose canonical is
     `<siteUrl>/recipes`;
   - the prerenderer writes `dist/recipes/index.html` with THAT head
     (nginx's try-files serves it before the SPA fallback), and the
     sitemap gains `{ loc: <siteUrl>/recipes }` — a sitemap entry must
     never contradict the canonical it points at, which is why the
     canonical change ships in the SAME step;
   - the hero route keeps the app-shell default head (canonical `/`) —
     it IS the homepage;
   - `src/lib/seoRender.ts` unit tests extend to the new entry (the
     sitemap builder is pure and golden-tested under `test:unit`).

## Consequences

- Every e2e spec that navigates to `/` and expects the catalog must move to
  `/recipes` (`waitForCatalog` stays valid on the recipes surface). This is
  the largest blast radius of the change: the full Playwright suite is
  re-pinned and runs ONCE, serially, at the END of the supervised run
  (standing rule); per-commit gates stay build + test:unit.
- `goHome()` (the header logo) is redefined per Q3 in Resolved questions.
- The prerendered `dist/index.html` (ADR-0048, `homeSeoHead()`) now
  describes the hero page — canonical-to-homepage becomes literally true.
- Room links (`<origin>/plan?room=<code>`) are untouched: a link join lands
  on the Plan tab as today, and `JoinCongratsModal` behaves unchanged.
- KeepAlive: `HomeView` is NOT added to the include list — the hero is
  stateless and cheap to re-render.

## Non-goals

- No accounts, no sign-up flow, no email capture (standing non-goal).
- No dark-mode-specific hero artwork: the hero uses the theme flip like
  every surface (`bg-surface`, `text-*` tokens; the tomato emphasis word
  keeps `text-brand` in both themes).
- No changes to room lifecycle, backup, or the derived grocery pipeline.

## Resolved questions

- **Q1 — does `/` always show the hero?** YES, always: no "first visit"
  state, no skip for returning users with a household or a plan. The home
  page has no memory; nobody is ever redirected past it.
- **Q2 — the app header on the hero route.** The header STAYS (logo,
  version, room chip, dark toggle); ONLY the bottom nav is hidden on `/`.
  The hero is not a fullscreen focus mode — the room chip must keep working
  there.
- **Q3 — the header logo (`goHome()`).** On `/recipes` it keeps the
  scroll-to-top behavior (its aria-label stays "Back to top of recipes"
  there). From every OTHER tab it navigates to the hero `/` (aria-label
  "Home"). On `/` itself it scrolls to top. Consequence: the recipes list
  is reachable from the hero in one tap ("Start planning"), and the hero is
  reachable from any tab via the logo.

## Alternatives considered

- Keep `/` as the recipes list and put the hero at a new `/welcome` —
  rejected: the owner's ruling is explicit that the home page is the hero.
- Gate the hero behind a "first visit" flag — see Q1's resolution.
- Reuse `isFullscreenMode` (hide header AND nav on `/`) — see Q2's
  resolution.
