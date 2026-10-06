# ADR-0055 — one tooltip component + mobile tap-reveal on the recipe detail view

* Supersedes (in part): ADR-0049 — Decision 6's hand-rolled room-chip bubble
  mechanics (its meaning-carrier rules are inherited, see Decision 7)
* Extends: ADR-0044 (icon-scoped tooltips — the touch gate and the
  pointer-transparent host SURVIVE everywhere they are pinned today),
  ADR-0040 (bubble + `hovercap` gate), ADR-0036 (DESIGN.md tokens)
* Status: **Accepted** (2026-10-06, owner rulings of 2026-10-06)
* Companions: `src/components/TooltipBubble.vue` (new),
  `src/components/HueIcon.vue`, `src/App.vue`,
  `src/components/{HistoryView,AutoPlanDialog,PlanTab,RecipeDetail}.vue`,
  `e2e/design-visual.spec.ts`, `e2e/household-ratings.spec.ts`,
  `e2e/user-recipes.spec.ts`, `e2e/tap-reveal.spec.ts` (new)

## Context

The app has no single tooltip component. Three surfaces implement "a
tooltip" today, each its own way:

1. `HueIcon`'s icon bubble (ADR-0044): `hidden` + a conditional
   `hovercap:block` class, revealed by `useIconHoverTarget` (the shared
   pointer hit-test — necessary because the host is `pointer-events-none`
   and can never match `:hover`) or `@focusin`, and gated by
   `@media (hover: hover)` so touch never reveals a bubble.
2. `App.vue`'s room chip (ADR-0049 Decision 6): a hand-rolled second
   bubble — plain CSS `group-hover:block group-focus-within:block`,
   `hidden` semantics, `max-w-56` + `right-0` anchoring (that shape is
   load-bearing: a `visibility`-based, centre-anchored bubble overflowed
   the Pixel 7 viewport and broke bottom-nav hit-testing).
3. Native `title="…"` attributes — ten of them, across `AutoPlanDialog`
   (2), `HistoryView` (2), `PlanTab` (2), `RecipeDetail` (2), `App.vue`
   (1, the app-version span) and `HueIcon` itself (1, on the glyph).
   Native `title` is unstyled and OS-rendered, never appears on keyboard
   focus or on touch, and is exactly the drift ADR-0049 replaced for the
   room chip.

Two bubbles is drift; ten `title`s is more drift. A new feature — mobile
tap-reveal — would otherwise have been written next to all of them.

## Decision

### Decision 1 — ONE tooltip component for the whole app (DRY)

`src/components/TooltipBubble.vue` is the only tooltip implementation.
Every tooltip surface routes through it: the icon bubbles, the room-chip
bubble, and every native `title`. Owner ruling, 2026-10-06: *"every
tooltip surface in the app routes through the one component."* Refactoring
the duplicate paths into one funnel happened BEFORE the tap-reveal feature
was written next to them.

The component renders the bubble only — never a wrapper around the host —
so call sites keep their own DOM. API:

```ts
props: {
  text: string                  // bubble content; empty ⇒ nothing rendered
  placement?: 'above-center' | 'below-right'   // default 'above-center'
  active?: boolean              // controlled (JS-driven) reveal
  tapReveal?: boolean           // opt-in tap reveal (Decision 4)
}
expose: { tap(), hide() }
constant TOOLTIP_TAP_REVEAL_MS = 3_000   // internal, not exported
```

`data-test` and other attributes fall through to the bubble's root span,
so existing selectors keep working (Decision 8).

### Decision 2 — three reveal modes, one state funnel, one FADE

The reveal STATE lives once, inside the component. The bubble's base
state is `opacity-0 invisible` — NEVER a `display` swap: every bubble
enters and leaves through an opacity+visibility transition (owner
refinement, 2026-10-06), so a closed bubble is transparent rather than
absent. This deliberately REVERSES the old `hidden`-not-`invisible`
rule, and the reason that rule existed is still honoured: the ADR-0049
Pixel 7 failure was an UNCLAMPED bubble widening the document until the
fixed bottom nav stopped receiving taps. A visibility-hidden bubble
occupies layout, so the same refinement mandates the in-viewport clamp
(Decision 3a): a bubble is never outside the viewport, never wider than
its `max-w`, and `pointer-events-none` — the document can never grow
because of one. Exactly one of three reveal mechanisms turns the
opacity/visibility on:

1. **Controlled** (the `active` prop is given): the caller owns detection
   and passes the verdict. Used by `HueIcon`, whose host is
   `pointer-events-none` (ADR-0044) and therefore invisible to `:hover` —
   `active` is `pointerInside || focusWithin` from `useIconHoverTarget`
   and `@focusin`. Reveal classes: `hovercap:opacity-100 hovercap:visible`
   — the ADR-0044 gate is preserved verbatim.
2. **CSS** (no `active` prop): the bubble carries
   `group-hover:opacity-100 group-hover:visible group-focus-within:…`
   statically and fires on the nearest `.group` ancestor — the ordinary
   pointer-active element case. Used by the room chip (its host span is
   already `group relative`) and by the migrated `title` hosts, which
   each gain `group relative`. No JS listener is spent on elements CSS
   can already cover.
3. **Tap-reveal** (the `tapReveal` prop): an internal `tapOpen` state with
   a 3 s timer; the open state is an INLINE `opacity:1; visibility:visible`
   style, deliberately UNGATED by `hovercap:` — this is the one place the
   touch silence is lifted, and only because the surface opted in
   (Decision 4).

The modes compose: `shown = active || tapOpen`, so a tap-reveal surface
keeps its hover/focus behaviour untouched on desktop. On a tap-reveal
surface in CSS mode the HOVER half of the reveal is additionally gated
by `hovercap:` — `hovercap:group-hover:…` — because a touch browser
can retain `:hover` after a tap, and an ungated group-hover would
re-open the bubble after the second tap hid it or the timer fired
(focus-within stays ungated: focus is not a touch artefact here).

### Decision 3 — two placement variants, both existing pinned shapes

No new shape was invented. The variants carry the classes that genuinely
differ between the two bubbles that exist today:

- `above-center` (HueIcon's pinned shape): `bottom-full left-1/2 mb-1.5
  w-max max-w-40 -translate-x-1/2 rounded-md text-[11px] leading-snug
  shadow-lg`.
- `below-right` (the room chip's pinned shape, `right-0` + `max-w-56`
  load-bearing per ADR-0049): `top-full right-0 mt-1.5 w-max max-w-56
  rounded-lg text-xs leading-snug shadow-md`.

### Decision 3a — the in-viewport clamp and flip (owner refinement, 2026-10-06)

Long tooltips must not clip outside the viewport. `TooltipBubble`
positions itself with its placement classes relative to the host (its
containing block), then applies a `transform` nudge computed from the
HOST's rect plus the bubble's own size: the preferred side (the
`placement` prop) is FLIPPED to the other side when the viewport has no
room for it, the horizontal position is clamped to an 8px viewport
margin, and the vertical position is clamped the same way. The
transform is applied even while the bubble is hidden, so the layout box
itself can never widen the document (the ADR-0049 failure mode).
Recomputation runs on mount, on text change, on resize and on any
scroll (rAF-throttled, passive, capture-phase) — never on the reveal
path itself, so a reveal is never delayed by measurement.

Shared chrome: `pointer-events-none absolute z-20 opacity-0 invisible
transition-[opacity,visibility] duration-150 w-max bg-surface-dark px-2
py-1 font-normal leading-snug text-text-dark` (the fade is Decision 2's;
`hidden` is gone — see there for why the ADR-0049 layout-occupancy
hazard is prevented by THIS clamp instead). The icon bubble's
`text-on-brand` unifies to `text-text-dark` (`#ffffff` → `#fff8f0` on
`#171310` — imperceptible, and both tokens already exist in DESIGN.md).
The room chip's `role="tooltip"` is retired: `aria-hidden="true"`
already removes the bubble from the a11y tree, so the role carried no
information and differed between the two bubbles for no reason. No new
colour token was needed.

Per-surface placement: icon bubbles keep `above-center`; migrated `title`
hosts use `below-right`, except sites where below would clip against the
host's scroll container — the Auto-Plan dialog's confirm button and meal
tile use `above-center` because the dialog scrolls vertically.

### Decision 4 — mobile tap-reveal: engaged per surface, by prop

Owner rulings, 2026-10-06: *"tapping a labelled icon on a touch device
shows its tooltip for 3 seconds, then it disappears"*; scope: *"Only the
recipe detail view gets the tap-reveal; browse cards stay hover-only."*

The capability is IN the component (`tapReveal` prop), the ENGAGEMENT is
per surface:

- **Engaged**: the recipe detail header's type icon, occasion icon
  (RecipeDetail's two `HueIcon`s — not over a stretched link, so the host
  may become tap-responsive there) and the household-recipe badge
  (RecipeDetail, same header row — equally not over a link). The badge is
  a raw lucide glyph, so it is wrapped in a `group relative` host span
  carrying the click and the bubble.
- **Not engaged**: everywhere else. On the browse grid the icon sits over
  the card's stretched link (`RecipeCard.vue`: link root with
  `after:inset-0`, `HueIcon` host `pointer-events-none`), so a tap there
  NAVIGATES — the tap-reveal is not merely disallowed there, it is absent
  by construction, and ADR-0044's `pointer-events-none` host +
  `hovercap` gate stay exactly as pinned. ADR-0044's rejection of a
  pointer-active icon host is explicitly re-confirmed for browse cards;
  the detail header is a scoped carve-out because no stretched link
  exists under it.

Tap-reveal rules, pinned:

- Duration: 3 000 ms, ONE constant (`TOOLTIP_TAP_REVEAL_MS`) in
  `TooltipBubble.vue`.
- Auto-dismiss on timeout.
- The open state is an INLINE `opacity:1; visibility:visible` style, not
  a class. The base chrome is `opacity-0 invisible`, and Tailwind sorts
  `.invisible` AFTER `.visible` inside the same layer, so a plain
  `visible` class can never open the bubble — the hover modes win only
  because `hovercap:visible` / `group-hover:visible` are VARIANTS, which
  sort after base utilities. An inline style is order-independent.
- A second tap while open hides IMMEDIATELY (toggle semantics — chosen
  over restart-timer: a user who taps again is dismissing, and the
  immediate hide makes that observable).
- The timer is cleared on unmount, which covers leaving the view —
  `RecipeDetail` unmounts its header icons on route change.
- On a hover-capable device the tap reveal is inert in practice (hover
  already shows the bubble); it is not conditional on device type — no
  `matchMedia` sniffing.
- The tap must not trigger stretched-link navigation on browse cards —
  non-issue by construction (see above), verified against
  `RecipeCard.vue`'s actual structure.

### Decision 5 — native `title` migration: every site becomes a hover bubble

All ten `title`s are supplementary information (visible text or the
accessible name already carries the meaning), so every site migrates to
the component's reveal — none becomes a new visible affordance:

| Site | Title content | Bubble | Reveal |
| --- | --- | --- | --- |
| `App.vue` app-version span | full version string | below-right | hover |
| `PlanTab.vue` Share button | "Share your plan via a link or a live room" | below-right | hover + focus-within (focusable button) |
| `PlanTab.vue` share-history label | cooked-history default explanation | below-right | hover + focus-within (via its checkbox) |
| `AutoPlanDialog.vue` meal-name `p` | full (line-clamped) meal name | above-center | hover |
| `AutoPlanDialog.vue` confirm button | conditional "Waiting…" | above-center | hover + focus-within; text empty once enabled ⇒ no bubble |
| `HistoryView.vue` group `h2` | conditional "Planned {absolute date}" | below-right | hover |
| `HistoryView.vue` row `p` | absolute last-cooked date | below-right | hover |
| `RecipeDetail.vue` household badge | household-recipe meaning | above-center | hover + TAP-REVEAL (detail-view scope) |
| `RecipeDetail.vue` cook-line `p` | absolute last-cooked date | below-right | hover |
| `HueIcon.vue` glyph `:title` | the icon's label | none | **dropped, not migrated** — the bubble is already the visual dual of the label; this closes ADR-0040's recorded follow-up ("drop title on bubble-bearing icons") |

Non-focusable hosts (`p`, `h2`, spans) reveal on hover only. That is the
information-parity the native `title` had (also unreachable by keyboard);
no `tabindex` is added, because growing the tab order for a cosmetic
bubble is an a11y regression, not an improvement.

**The bubble is a DESCENDANT of its `.group` host — never a sibling.**
`group-hover:` is a descendant selector, so a bubble placed BESIDE the
host can never fire (an initial sibling layout was corrected after the
first review round caught it). The host is therefore chosen per site so
that no text a consumer reads is polluted:

- where the host's own text is read verbatim by the e2e (the Auto-Plan
  preview tile reads the `p`'s `textContent` and looks the meal up as a
  heading), the `group relative` host moves UP a level — the tile `li`
  hosts both the p (clean text) and the bubble; the tile's
  `overflow-hidden` moved onto the image (`rounded-t-lg`), because an
  absolutely-positioned bubble would be clipped by its own tile.
- where only role/accessible-name or `toContainText` assertions exist
  (buttons, the room chip, the cook line, the group title), the bubble
  hangs directly under the host: `aria-hidden` keeps it out of the
  accessible name, and `toContainText` tolerates extra text.

The room chip keeps the bubble inside the chip span — that was the
pre-ADR-0055 structure, with the same text, so no spec surface changes.

### Decision 6 — what survives from ADR-0044, named explicitly

- The shared pointer hit-test (`useIconHoverTarget`) — untouched.
- The `pointer-events-none` host on pointer-transparent surfaces —
  untouched for every surface that keeps it (browse cards).
- The `hovercap:` media gate — untouched everywhere except an ENGAGED
  tap-reveal bubble's open state.
- The `@focusin` keyboard reveal — untouched.
- `RatingStars`' `group/htt` rating preview is NOT a tooltip (ADR-0044
  §3): a different hover surface with its own group. It is NOT migrated
  to `TooltipBubble`; see Non-goals.

### Decision 7 — a11y rules inherited from ADR-0049

The accessible name (aria-label) stays the single carrier of meaning; the
bubble is `aria-hidden="true"` and never announced. `TooltipBubble` hard-codes
that: the root is always `aria-hidden`, and no prop can turn it off. The
room chip keeps `aria-label={roomChip.description}` on the chip and the
bubble repeats it verbatim, exactly as ADR-0049 Decision 6 specified.

### Decision 8 — e2e selector names kept

`data-test="icon-tooltip"` (`e2e/design-visual.spec.ts` ~742/803,
`e2e/household-ratings.spec.ts` ~188) and `data-test="room-chip-tooltip"`
are kept through the component — attribute fallthrough makes the names
 arrive at the bubble root, so no spec asserts a dead selector and no
 rename churn. `e2e/user-recipes.spec.ts` asserted the household badge's
 native `title`; that assertion is rewritten to the bubble in the same PR.
 The new tap-reveal case runs on the Pixel 7 project: tap the detail
 header's type icon, bubble visible, auto-hidden after ~3 s, second tap
 hides immediately.

## Consequences

- One bubble implementation, one chrome, one tap-reveal timer. A future
  tooltip change lands once.
- `TooltipBubble` in CSS mode requires a `.group` ancestor — the wrapper
  class is part of each call site's contract and is called out in the ADR.
- Native `title` disappears from `src/` entirely (verified by search); the
  grocery provenance pill's `cursor-help` affordance is not a `title`
  surface and is untouched.
- The controlled mode's `active` prop keeps `HueIcon`'s subscription
  logic (`useIconHoverTarget`) in place — no behaviour ADR-0044 pins was
  deleted.
- Playwright: the touch path is pinned on the Pixel 7 project with a real
  3 s wait in one test (accepted cost).

## Alternatives considered

| Option | Verdict |
| --- | --- |
| Keep three implementations, add tap-reveal as a fourth | **Rejected** — the exact drift this ADR ends; three more places to keep in visual and a11y lockstep. |
| A headless tooltip wrapper component (slot-based, wraps the host) | **Rejected** — would re-parent DOM at ten call sites, risking the stretched-link and overflow geometries the existing specs pin; the bubble-only component changes nothing outside the bubble. |
| Tap-reveal as a global behaviour on ALL labelled icons | **Rejected by owner** — browse cards stay hover-only; a tap-revealing bubble over a stretched link would fight navigation. |
| Tap-reveal via a `touchstart` listener | **Rejected** — click works for taps, needs no passive-listener dance, and behaves for mouse users too. |
| Rename `icon-tooltip` to a component-owned constant | **Rejected** — churn in three specs for zero behaviour; the name survives through fallthrough. |

## Non-goals

- `RatingStars`' rating preview (`group/htt`): a different hover surface
  per ADR-0044 §3, not a tooltip, deliberately untouched.
- The grocery provenance pill (`cursor-help`): not a `title` surface.
- Tap-reveal outside the recipe detail view (incl. the browse grid).
- New colour tokens: none were needed; both bubbles keep their existing
  `bg-surface-dark` chrome.

## Decision log

- 2026-10-06 — owner ruling: ONE tooltip component (DRY); every tooltip
  surface routes through it.
- 2026-10-06 — owner ruling: tap-reveal is mobile touch only, 3 s, then
  disappears.
- 2026-10-06 — owner ruling: tap-reveal scope is ONLY the recipe detail
  view; browse cards stay hover-only (stretched-link geometry).
- 2026-10-06 — second tap while open chosen to HIDE immediately
  (toggle), over restarting the timer.
- 2026-10-06 — `icon-tooltip` / `room-chip-tooltip` selector names kept
  via attribute fallthrough.
- 2026-10-06 — OWNER REFINEMENT: the detail-view household badge's
  bubble text is just "New" (not the full authorship sentence) — the
  aria-label stays the meaning-carrier; the bubble is its short visual
  dual.
- 2026-10-06 — OWNER REFINEMENT: every bubble fades in/out via an
  opacity+visibility transition (no display swap), and placement must
  not clip: TooltipBubble flips the vertical side when the preferred one
  does not fit and nudges at the screen edges (Decision 3a). The 3 s
  tap-dismiss timer and the browse-card hover-only rule are explicitly
  UNCHANGED by this refinement.
