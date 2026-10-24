# ADR-0096: The home page serves the recipes list to returning users

Status: accepted (2026-10-24)

## Context

ADR-0078's Q1 ruled the hero shows for EVERY `/` visit — "no first-visit
state, no skip for returning users with a household or a plan. The home page
has no memory; nobody is ever redirected past it." In practice a returning
user — somebody with a plan, a household room, or both — opens flambette.app
and is shown the marketing statement every single time, after the hero has
already done its job for them. The owner has reversed that ruling: for a
device that has used the app, the home page should BE the recipes page (the
app's actual working surface), and the hero moves to an always-accessible
URL. ADR-0078's own "Alternatives considered" rejected a `/welcome` hero —
that rejection was about WHERE the hero lives for a new visitor, which this
record keeps; what changes is what a RETURNING visitor lands on.

## Decision

1. **The predicate is derived, never stored.** A device is "returning" when
   it holds state that proves use: the plan has entries, the device stands
   in a live room, OR a household room code is saved (ADR-0019's persisted
   setting — the signal that covers a room whose session has not resumed
   yet at first-navigation time). No one-time "has seen the hero" flag:
   derived state is self-healing (a user who clears everything is new
   again) and backup-faithful (a restored archive reproduces every signal).
   The decision is the pure, unit-tested `hasUsedApp()` in
   `src/lib/usedApp.ts`; the router guard feeds it from the stores.

2. **Routes.** `/` keeps the name `home` and `HomeView`, and gains a
   `beforeEnter` guard: a returning device is REPLACED onto `/recipes`
   (name `recipes` unchanged). `replace`, never a push — no `/` entry is
   left in history and Back never bounces off a redirect. A new route
   `/welcome` (name `welcome`, same `HomeView`) is the hero's
   always-accessible home. A route-level redirect was chosen over rendering
   `RecipesTab` inside a conditional wrapper at `/` deliberately: a wrapper
   would run TWO live `RecipesTab` instances (the KeepAlive-cached one for
   `/recipes` plus the wrapper's inner child) and would have to re-teach
   six route-name-keyed surfaces — tab highlight, nav visibility, the
   `isHome` layout padding, `goHome()`, the freshJoin landing watcher and
   the head gate — to treat `/` as recipes. With the redirect the user
   genuinely IS on `recipes` and every one of those surfaces keeps working
   unchanged.

3. **The guard never eats a link join.** The redirect carries the incoming
   query (`?room=`, `?p=`) into the target, so a returning device opening a
   household link is redirected WITH its join intact; `joinRoomFromLink`
   runs at app level on whatever route it lands on.

4. **`/welcome` is discoverable from Settings.** The About card
   (`data-test="about-card"`) gains three owner-directed affordances:
   - a link to `/welcome` ("What is Flambette?"), the in-app path to the
     hero;
   - the Info tile becomes a real BUTTON that opens the changelog modal
     (previously a decorative span while the prose pointed at the header's
     version button — the card now owns its own trigger);
   - a GitHub tile linking the repo
     (`https://github.com/Belphemur/flambette`, new tab).
   The changelog modal's open state moves from an App.vue local ref into
   the ui store as a NON-persisted transient slot, exactly like `toast`
   and `confirm` — Settings and the header version button now open the
   same ONE modal through the same ONE slot (no second trigger state, no
   STORE_SLICES entry, nothing persisted).

5. **`/welcome` mirrors the hero's chrome rules** (ADR-0078 Decision 2/Q2):
   no bottom nav, header stays, the hero owns its padding. `isHome` widens
   to both hero route names, and the freshJoin landing watcher's exclusion
   set gains `welcome` beside `home` (Decision 7's rule now names both hero
   URLs — a create or join made FROM `/welcome` must not navigate away
   while the household modal is open).

6. **`goHome()` (Q3) keeps its shape, its destination is now
   guard-decided:** from a tab it pushes `home` — the guard turns that into
   `/recipes` for a returning device (their home IS the recipes list) and
   into the hero for a new one; on the hero routes and `/recipes` it stays
   a scroll-to-top (`welcome` joins the same-page branch).

7. **SEO unchanged.** Crawlers never carry storage, so `/` still serves the
   hero to them: `dist/index.html` keeps `homeSeoHead()` with canonical
   `/`; `/recipes` keeps its own head; `/welcome` is an SPA-fallback
   surface carrying the homepage head with canonical `/` (ADR-0048's
   duplicate-content defence) and stays out of the sitemap. No
   `generate-recipe-seo.ts` change.

8. **Catch-all** `/:pathMatch(.*)*` still redirects to `/` — a returning
   device then lands on `/recipes`, a new one on the hero.

## Consequences

- e2e: the two home-hero specs that SEED membership (the saved-household
  re-join and the live-room re-open) re-pin to `/welcome`; the fresh-context
  hero specs are untouched (a fresh context is not a returning device). A
  new spec pins the redirect itself: a device with a seeded plan opening `/`
  lands on `/recipes` with the grid. The About card's new affordances get
  e2e coverage too (info icon opens the changelog, GitHub link href,
  welcome link navigates). Full suite ONCE at the end (standing
  rule); per-commit gates stay build + test:unit.
- A returning user pressing the header logo from any tab lands on their
  recipes list, and the URL reads `/recipes` — the honest address of what
  they are looking at.
- The hero's CTAs are unchanged and behave identically from `/welcome`.
- Back-history stays clean: the replace consumes the `/` entry, so Back
  from `/recipes` after an app-open on `/` goes to whatever preceded the
  app, not to a bounced `/`.

## Alternatives considered

- Conditional render at `/` (URL stays `/`) — rejected: dual live
  `RecipesTab` instances against a KeepAlive-cached tab, plus six
  route-name-keyed surfaces to re-teach, for a URL bar nobody asked about.
- `/` = recipes for everyone, hero only at `/welcome` — rejected: a NEW
  visitor would land in the dense grid with no statement of what the app
  is, defeating ADR-0078's purpose.
- A persisted "has seen the hero" flag — rejected: derived state is
  self-healing and backup-faithful; a flag lies after a restore or a
  cleared plan, and it would need a STORE_SLICES/backup review this change
  does not need.
