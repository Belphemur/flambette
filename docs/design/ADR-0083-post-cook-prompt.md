# ADR-0083: The post-cook prompt — rate and favourite when the meal is done

Status: accepted (2026-10-12)

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
