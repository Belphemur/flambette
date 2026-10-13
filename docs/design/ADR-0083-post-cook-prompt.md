# ADR-0083: The post-cook prompt — rate and favourite when the meal is done

Status: accepted (2026-10-12) — implemented in PR #84

## Context

Owner asks (2026-10-12), while ADR-0082's rating card is in review on
`feat/rating-star-ux` (PR #84):

1. "When somebody finishes cooking a recipe we should show a modal asking to
   rate and/or favourite the recipe."
2. "When closing the prompt the user should be sent back to the history."

Today the end of a cook session is silent about the two things a person is
most likely to want at that exact moment. `finishCooked()` (CookingView) is
ONE action — record the cook event (ADR-0032 history) and take the meal off
the plan — then closes the session with a toast, "Enjoy! Marked as cooked",
carrying an Undo action (ADR-0020's Finish-is-the-mark contract). The rating
control (ADR-0082 card, same `RatingStars` component) and the favourite
toggle (ADR-0014 family) both exist, but nothing connects the completed meal
to them.

## Decision

- **One new component, `PostCookPrompt.vue`**, shown by the cooking session
  after a successful `finishCooked()` — not a route, not a separate screen:
  the session stays mounted one extra step and raises an `AppModal`
  (ADR-0039 machinery: focus trap, Escape-to-nearest, scrim). Heading:
  **"Enjoyed it?"**.
- **Content — the existing controls, mounted, never re-implemented (DRY):**
  the same `RatingStars` at the card sizes (32 mobile / 24 desktop via the
  component's own `lgSize`, ADR-0082 contract, `data-rating` unchanged) for
  the cooked variant, and the same `FavouriteButton` beside it. A rating
  made in the prompt writes the SAME ratings store (room-synced, ADR-0074);
  a favourite toggle writes the favourites store. No second star widget, no
  second favourite control.
- **Ack replaces the toast.** When the prompt shows, the "Enjoy! Marked as
  cooked" toast does NOT also fire — the modal heading is the
  acknowledgment. **Undo moves into the modal**: a small "Undo — not actually
  cooked" text control calls the SAME `plan.undoMarkCooked(event, prior)`
  the toast's Undo calls, clears the session's `sessionCooked`, closes the
  prompt, and STAYS in the cooking session (the record is gone; the cook
  resumes where it was). Removing the toast's undo without a replacement
  would be an ADR-0020 regression, so it is carried, not dropped.
- **Every close returns to History.** Done button, scrim tap, and Escape all
  do one thing: close the prompt and `router.push('/history')` — the cooked
  entry just landed there (ADR-0032), so the user is sent to the thing they
  just made. There is no "dismiss and stay"; the cook session is finished,
  and History is the honest destination. The toast path (markCookedEarly,
  `close: false`) does NOT prompt: the prompt is for the Finish completion,
  not for mid-cook marks.
- **Identity of the prompt's rating target** is the cooked variant id
  (the same id the ratings store keys on) — a half-star grid from inside the
  prompt persists exactly like a rating made on the detail card.
- **a11y + selectors**: `data-test="post-cook-prompt"` on the modal,
  `post-cook-done`, `post-cook-undo`; the stars keep their existing
  role/aria contract (ADR-0040 string table untouched); the favourite button
  keeps `FavouriteButton`'s own contract.
- **Dark mode and tokens**: the prompt uses the existing surface/border/
  text tokens (no new hex); the modal sits on `bg-surface-dark`-equivalent
  per AppModal's existing presentation.

## Consequences

- e2e (household-ratings / cooking specs): finish on the last step → prompt
  appears with heading, stars, favourite; rating from the prompt persists
  (assert via the store contract + history page); Done → URL is `/history`
  and the history page shows the just-cooked entry; Escape and scrim close →
  `/history` too; Undo → back in the cooking session with the record
  removed; markCookedEarly never shows the prompt.
- PRD: the cooking surface gains the post-cook prompt row in the SAME change
  (PRD is the living product authority — no silent divergence).
- `docs/agents/cooking.md` documents the prompt in the finish-flow row.
- The five-tab bottom navigation is unaffected: the prompt is a modal over
  the cooking session, and /history is reached by the close action, not by
  tab re-measure (ADR-0016 untouched).

## Alternatives considered

- Toast-only with a "Rate" action: too small a target for the moment's
  intent and it would bury the favourite toggle; a modal is the ask.
- Navigating straight to History and prompting THERE: splits the moment
  across two screens and risks the prompt reading as a History-page
  interstitial; the owner asked for close → History, not prompt ON History.
- Skip prompt when the household already rated the variant: rejected — the
  prompt also carries the favourite toggle and the Undo; a household that
  re-cooks may re-rate (half-grid overwrites, tombstone/clear unaffected).

## Addendum (2026-10-12): marked as cooked anywhere — one completion experience

Owner ruling: **"marked as cooked" IS "I have finished"** — the same
completion experience wherever the mark happens, and the prompt must be
reachable from the recipe detail page, because not everybody enters through
cooking mode.

- **The mid-cook mark raises the SAME prompt.** `markCookedEarly` no longer
  keeps a private toast+Undo path: a mark at ANY point of the cooking
  session records the cook and raises the PostCookPrompt. The dedicated
  "Marked as cooked" toast is retired for this path — the modal IS the
  acknowledgment. Finish and Mark converge on ONE code path (DRY):
  record → prompt; Done → `/history` (session ends); Undo → record
  removed, session resumes exactly as before (ADR-0020's
  Finish-is-the-mark contract now reads: any mark is the mark).
- **The detail page gains the floating "Cooked this?" pill.** Design
  authority: Stitch project 2725470430841257407 (Warm Culinary Paper),
  screen "Flambette — Recipe Detail End (Mobile Dark)": a compact
  icon+label pill anchored to the RIGHT edge, ~120px above the bottom
  navigation — `surface-raised` fill, subtle `#564438` border, soft popover
  shadow, warm accent dot. Unobtrusive by contract: it covers no reading
  content and never overlaps the tab bar. It appears when the LAST THREE
  STEPS come into view (an IntersectionObserver on a sentinel riding the
  third-from-last step — the pill belongs to the END of the recipe, where
  "I cooked this" becomes true; on desktop the instructions COLUMN is in
  view on load, so a section-level trigger would light the pill before
  any scroll — owner refinement, 2026-10-13), and is hidden once
  the cook is recorded (or already recorded today — same guard the cooking
  session uses).
- **Tap = record + the SAME prompt, no separate flow.** The pill records
  the cook through the ONE `plan.markCooked` path the cooking session uses
  (plan-aware: a planned meal comes off the plan; an unplanned cook still
  records, ADR-0032) and raises the PostCookPrompt over the detail page.
  Done → `/history`; Undo → record removed and the user stays on the
  detail page (there is no session to resume). The prompt component stays
  trigger-agnostic: triggers own only their context (what Undo restores),
  the prompt owns the experience.
- **Naming**: the pill's label is "Cooked this?" (the render's words) —
  NOT "Mark as cooked", which stays the cooking session's in-flow action.

## Review hardening (2026-10-13, PR #84 round 2)

Two clarifications from code review; no behavior contract changes:

- **The prompt owns ALL keys while it is open.** The cooking session's
  `onKey` yields before its ArrowRight/ArrowLeft/Escape branches, so
  keyboard navigation cannot advance the covered session behind the
  modal (a later Undo would otherwise resume on an unseen, shifted
  step). Escape still routes through AppModal's close, exactly as the
  "every close returns to History" bullet already specifies.
- **The mid-cook mark button's accessible name is "Mark as cooked"** —
  the former "…and keep cooking" suffix overstated what the mark does
  now that the prompt (whose non-Undo exit ends the session) is the
  mark's acknowledgment.

## Consequences (addendum)

- `docs/agents/cooking.md` and the PRD cooking surface are updated in the
  SAME change as the addendum's implementation (PRD rule).
- e2e: the mid-cook mark prompts (its old toast+Undo spec flips to the
  prompt contract — the flip the phase-2 gate already surfaced); the pill
  appears when steps scroll into view and is absent once recorded; tap →
  prompt → history; Undo from the pill keeps the user on the detail page
  with the cook removed.
- The plan-interaction edge (marking cooked from detail when the recipe is
  not planned) follows the standing rule that a cook records regardless of
  plan membership; nothing in the prompt reads plan state.

## Change note — 2026-10-13, owner ruling: the pill is INLINE (no observer)

The addendum's pill bullet (and its consequences line, "the pill appears
when steps scroll into view") originally specified the FLOATING right-edge
pill with an IntersectionObserver on a tail sentinel. On review the owner
ruled the pill STRUCTURAL and INLINE (commit `c0d2eea`, this PR): it renders
in the TITLE ROW of each of the LAST THREE steps — beside the number badge,
in document flow — and the trigger is the step list itself, with NO
IntersectionObserver and no scroll precondition. Two reasons, both recorded
in the code comment at the render site:

- the fixed overlay blocked the step text on both layouts (the owner's
  "going from title to title" refinement);
- the Firefox no-pill report is fixed at the root: an IntersectionObserver's
  callbacks never fire in a hidden or occluded tab, so an observer-based
  trigger can silently never light — a structural render cannot.

The floating/observer wording above is therefore superseded WITHIN this PR
(ADR-0083 has not landed on main separately from this fix, so no new record
is opened); the bullet is kept for the decision trail. `docs/agents/cooking.md`
and the PRD cooking surface carry the shipped inline contract in the same
change (PRD rule).

## Change note — 2026-10-13, owner ruling: the pill SLIDES (one at a time)

The static-inline draft above ("each of the LAST THREE steps carries the
pill") was refined the same day by the owner: the pill must "continue to
slide, but hook every time on the title until the next step becomes visible
and then show only on the next step — only visible on the visible
instruction, always the latest one". The shipped contract: exactly ONE pill
at a time, hooked INLINE on the title row of the LATEST step that has
entered the viewport, handing off to the next step's title as the scroll
advances (and hopping back when scrolling up). The trigger is a passive,
rAF-throttled window-scroll read of the steps' `getBoundingClientRect` —
deliberately NOT an IntersectionObserver, whose callbacks never fire in
hidden/occluded tabs (the Firefox no-pill report); a window listener also
covers every scroll container (the sticky ingredient column's). The
cooked-today suppression, the single `plan.markCooked` path, and the
prompt's Done → `/history` / Undo → stay semantics are unchanged. Pinned by
`e2e/cooked-pill.spec.ts` ("exactly ONE pill, on the latest step whose
title entered the viewport").

## Change note — 2026-10-13, owner ruling: the pill is ICON-ONLY on the STATIC last-3 tail

The slide contract above was superseded the same day: the owner asked to
"go back to the fully sliding version from instructions last -3, but with
one change, use an icon instead of text, one that look like checkmark or
cooked meal". Decoded, the owner names the ZONE (the last three steps)
and reverts to the STATIC contract: every one of the LAST THREE steps
carries the pill in its title row, structural rendering, NO scroll
tracking and NO observer (the slide machinery — rAF scroll read, ref
map, one-at-a-time handoff — is deleted). The one change vs. the
static-tail draft is the pill's CONTENT: ICON-ONLY — a CookingPot glyph
(the "cooked meal" icon; ChefHat stays the Start-cooking CTA, the
generic Check is retired) beside the brand accent dot, with the
accessible name `Cooked this? (reached step N)` carrying the words. The
cooked-today suppression, the single `plan.markCooked` path, and the
prompt's Done → `/history` / Undo → stay semantics are unchanged. Pinned
by `e2e/cooked-pill.spec.ts` (tail counts with no scroll precondition,
icon-only content).

## Change note — 2026-10-13, owner FINAL ruling: the pill SLIDES WITHIN the last-3 zone, icon-only retained

The static-tail note above was superseded the same day: reviewing the
icon-only version, the owner wrote "Good icon not the right revert. I
wanted to get the pill back that is sliding with the scroll when reached
the last step -3 so 3 steps before the last" — the ICON-ONLY content is
confirmed ("good icon"), the STATIC rendering is not. The contract is
now BOTH at once: the slide machinery is restored (passive
rAF-throttled window-scroll read via `getBoundingClientRect`,
function-ref step map, one-at-a-time handoff, NO IntersectionObserver),
with a NEW ENTRY GATE — the pill exists only when the latest visible
step index is >= `length - 3`; above the zone there is NO pill anywhere,
and scrolling out of the zone (back up) removes it. Inside the zone the
single pill rides the title row of the latest visible step, handing off
as steps enter/leave the viewport in both directions. The icon-only
treatment is kept verbatim from the icon-static ruling: brand accent
dot + one CookingPot glyph, no text spans, the accessible name
`Cooked this? (reached step N)` carries the words. The cooked-today
suppression, the single `plan.markCooked` path, and the prompt's Done →
`/history` / Undo → stay semantics are unchanged. Pinned by
`e2e/cooked-pill.spec.ts` (geometry-driven: no pill above the zone,
exact one-pill handoff + back-hop inside it, icon-only content). This
note supersedes the two 2026-10-13 notes above; both are kept for the
decision trail.
