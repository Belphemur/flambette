# ADR-0098: Recipe detail as a cooking surface — screen wake + inline end-of-recipe mark on mobile

Status: accepted — implemented in PR #106 (2026-10-26) — supersedes ADR-0083 in part (mobile pill rendering only)

## Context

The recipe detail page (`/recipe/:id`) is the cooking reference for the
majority of users who never enter cooking mode (ADR-0034 / ADR-0083
addendum). Two gaps exist today:

1. **No screen-awake on the detail page.** CookingView keeps the screen on
   via the Screen Wake Lock API (ADR-0020); the detail page does not. A
   reader following steps in the kitchen on a phone has the screen dim and
   the device sleep, losing their place.
2. **The "Cooked this?" pill is a floating overlay on every layout
   (ADR-0083 change notes).** On mobile the floating pill competes with the
   bottom navigation and the scrolling content, and the wiggle animation
   (ADR-0083 pill-round ruling) is a nudge the user asked to replace with
   something they can act on directly.

Owner ruling (2026-10-26): the detail page should *treat itself as a
cooking surface* on mobile — keep the screen awake — and instead of the
side nudge, surface a direct CTA after the last step. When pressed, it
must show the same "Enjoyed it?" post-cook prompt (ADR-0083) and the user
must be able to press it more than once (a recipe can be cooked repeatedly).
It should "act like the button at the top" — i.e. reuse the single
`plan.markCooked` path and the same Done → `/history` / Undo → stay
semantics, with no cooked-today suppression (already retired in ADR-0083
pill-round).

Design authority: Stitch project 2725470430841257407 (Warm Culinary Paper),
screen "Flambette — Recipe Detail End (Mobile Dark)" (ADR-0083 addendum
cites this as the geometry authority for the end-of-detail mark affordance).
The inline CTA follows the same warm-surface, tomato-accent, CookingPot
glyph language the Stitch renders establish.

## Decision

- **Screen Wake Lock on RecipeDetail.** A best-effort Screen Wake Lock
  (`'screen'`) — acquire on `onMounted`, release on `onUnmounted`, and
  re-acquire on `visibilitychange` when the tab returns to visible
  (Chromium fires a `screenunavailable` event when the user switches apps).
  The lock degrades to a no-op when the API is absent or denied
  (private tab, cross-origin iframe, unsupported browser) — the detail
  page still renders and the cook flow is untouched. No runtime
  dependencies; this is the same pattern CookingView ships (ADR-0020).
  The wake lock is active on both layouts: the API is harmless on desktop
  and the detail page is a cooking surface wherever it runs.

- **Mobile (below `lg`): floating pill → inline CTA.** The floating
  "Cooked this?" pill (`data-test="cooked-pill"`) is DESKTOP-ONLY
  (`lg`+). On mobile its slot is replaced by an inline
  `data-test="detail-cook-cta"` button rendered in document flow
  immediately after the `<ol>` step list — "after the last step", always
  in the DOM once the recipe is loaded, no tail sentinel and no wiggle
  animation on mobile (the nudge is retired where the overlay caused the
  conflict). The CTA text is "Mark as cooked" (the cooking session's
  in-flow label, ADR-0083 addendum); the icon-only pill label on desktop
  is untouched.

- **Desktop (`lg`+): floating pill unchanged.** Every desktop ruling in
  ADR-0083 survives: icon-only content, full text label from `2xl`,
  free-margin placement (`calc(100% + 40px)` at `xl+`), always visible,
  wiggle (icon-only, pulsing, `prefers-reduced-motion` gated), flick
  dismiss (`PILL_DISMISS_PX`, `pillDismissedRecipes` in the persisted ui
  slice), tail-sentinel trigger. Only the mobile layout is altered.

- **One mark path, one prompt.** The inline CTA and the floating pill
  both call the same `recordCookFromDetail()` — the single
  `plan.markCooked` path the cooking session uses (plan-aware: planned
  meals come off the plan; unplanned cooks still record, ADR-0032). The
  mark raises the existing `PostCookPrompt` ("Enjoyed it?") over the
  detail page; Done → `/history`; Undo → record removed and the user
  stays on the detail page. The CTA is always offered on every visit —
  no cooked-today guard — so it can be pressed more than once.

- **`data-test` selectors.** The inline CTA carries
  `data-test="detail-cook-cta"`. The floating pill keeps
  `data-test="cooked-pill"`. The `PostCookPrompt` keeps
  `data-test="post-cook-prompt"` and its existing children.

## Consequences

- **e2e (`e2e/cooked-pill.spec.ts`):** Desktop Chrome asserts the
  floating pill only; Pixel 7 asserts the inline CTA `detail-cook-cta`
  after the step list and the absence of `cooked-pill`. The CTA and pill
  both raise `post-cook-prompt` → Done → `/history`, Undo → stay on
  detail. New wake-lock spec in `e2e/recipe-detail.spec.ts` (or
  `cooked-pill.spec.ts`): the detail page holds a wake lock sentinel —
  asserted via a mock `navigator.wakeLock.request` that resolves on
  mount and is released on navigation/unmount.
- **`docs/agents/cooking.md`:** the cooking surface table row for the
  detail page becomes "wake lock + desktop pill / mobile inline CTA",
  written in the SAME change as the implementation (PRD rule).
- **PRD:** the cooking surface row is updated to note the detail page
  keeps the screen awake and offers the end-of-recipe inline CTA on
  mobile.
- **No new runtime deps:** the wake lock is a no-op on unsupported
  surfaces; the inline CTA reuses the existing `PostCookPrompt` and the
  existing `plan.markCooked` path.
- **ADR-0083** gains a trailing note pointing to this record for the
  mobile-pill supersession; the desktop rulings in ADR-0083 are not
  re-listed here — they remain the authority for `lg`+ rendering.
- **`tsconfig.app.tsbuildinfo`** may appear modified after a build; it
  is gitignored and must not be committed.
- **History hygiene:** no Mealime token, `user_data.json` PII, or
  `.pi/` paths are introduced into git history.
