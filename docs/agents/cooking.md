# Cooking mode (ADR-0020 → ADR-0081)

The cooking view is the immersive kitchen surface (`/cooking/:id`): one
step at a time, inside the 672px `max-w-reading` measure (ADR-0073 — a
step read at arm's length wants a measure, not a page).

## Composition (ADR-0081, the current contract)

Top to bottom: slim header (recipe title one-line truncate, mono progress
line `serves N · Step i / n`, thin tomato progress bar, close), the STEP
TEXT as the dominant element (20px/30px mobile, 22px/34px desktop), then
two cards, then the action deck.

- **"This step uses" checklist card**: the ADR-0022 measured-amount chips
  are superseded in PRESENTATION ONLY by interactive checklist rows —
  full-row ~56px tap targets, 20px rounded checkboxes, bold mono amount +
  ingredient name; checked = success green fill + struck-through muted
  text (ADR-0072: completion is the success family, NEVER a food hue, on
  a checkbox). The DERIVATION is untouched — same `measuredAmounts.ts`
  source, same nameKey word-boundary matching, same no-invented-quantity
  rule, same scaling import. Checked state is per-step ephemeral view
  state.
- **"Timers for this step" card** — a TWO-STATE disclosure:
  - **Collapsed** (nothing known or running): a single ~56px tappable
    row titled "Set a Timer" with the honest hint "No timer running for
    this step." — ALL creation controls hidden.
  - **Expanded** (auto): a RUNNING timer opens the running view (large
    mono tomato countdown, name, slim progress bar, Pause/Cancel) with
    the creation form collapsed behind a "Set another timer" disclosure;
    a DETECTED hint with nothing running opens directly on the
    suggestion view. The saffron "No cook time mentioned in this step —
    set one if needed." banner NEVER renders while a timer exists.
  - **ONE presence predicate (DRY)** owns "does this step have a timer":
    it consumes BOTH the ADR-0041 hint resolution AND `ui.stepTimers`,
    and drives the card state, the hint line's wording and the banner.
    A second derivation that answers the same question differently is a
    defect (observed and fixed — the collapsed card claimed "no timer"
    while the expanded form said "Detected: 10 min").
  - The creation form is collapsed by default in BOTH states; expanding
    it is always an explicit tap. Presets are labelled quick-start
    affordances, never presented as detections; no invented durations.
- **Action deck**: outlined Previous + filled-tomato Next (flex-1); a
  full-width tonal success-green "Mark as cooked" below — TOMATO =
  begin, SUCCESS = complete (ADR-0072).
- **Post-cook prompt (ADR-0083)**: a successful Finish raises
  `PostCookPrompt` on `AppModal` over the still-mounted session —
  heading "Enjoyed it?", the ONE `RatingStars` (32/24, same ratings
  store, half-grid) and the ONE `FavouriteButton` for the cooked
  variant, a Done control and an "Undo — not actually cooked" text
  control calling the SAME `plan.undoMarkCooked(event, prior)` the old
  toast Undo called (the prior is captured alongside `sessionCooked` in
  session state — `sessionPrior`). The modal IS the acknowledgment: the
  "Enjoy! Marked as cooked" toast does NOT fire on this path, and Undo
  has moved into the modal (carried, not dropped — no ADR-0020
  regression). Done, scrim and Escape all close the prompt and navigate
  to `/history`; Undo closes it and STAYS in the session with the record
  removed. `data-test`: `post-cook-prompt`, `post-cook-done`,
  `post-cook-undo`.
- **Mark-anywhere (ADR-0083 addendum)**: "marked as cooked" IS "I have
  finished". The mid-cook mark and Finish converge on ONE code path —
  `recordCook()` records and raises the SAME prompt (the modal IS the
  acknowledgment wherever the mark happens, so the dedicated
  "Marked as cooked" toast + toast Undo is RETIRED). The prompt's Undo
  is what keeps you cooking now: record removed, session resumes exactly
  where it was. The window Escape handler yields while the prompt is
  open (registration order — it fires before AppModal's).
- **The detail "Cooked this?" pill (ADR-0083 addendum)**: RecipeDetail
  gains the compact floating pill from the Stitch render ("Recipe Detail
  End (Mobile Dark)", Warm Culinary Paper) — right edge of the app
  column, 120px above the bottom navigation (safe-area aware),
  `bg-surface-raised`, subtle `border` token, the ONE `shadow-popover`,
  warm brand accent dot. Visible once the LAST THREE STEPS come into
  view (a sentinel rides the third-from-last step —
  `useIntersectionObserver` from @vueuse, never a hand-rolled observer;
  NOT the instructions section, which on desktop is in view on load, so
  a section trigger lit the pill before any scroll) and hidden once the
  recipe is already cooked TODAY (`cookedToday()` in
  `src/lib/history.ts`, local-day rule). A tap records through the ONE `plan.markCooked` path (captures
  the prior exactly like the session does) and raises the SAME
  `PostCookPrompt` over the detail page: Done → `/history`; Undo →
  record removed and the user STAYS on detail. `data-test`:
  `cooked-pill`; the prompt keeps the prompt's own hooks.
- Rejected render fictions: the "ACTION STEP" badge, difficulty labels,
  est-times beyond the recipe's own minutes.

## Timer semantics (ADR-0020 — untouched)

ONE timer per step VIEW (a Meanwhile pair is one view, ADR-0010), stored
as `{remaining, running, startedAt}` in `ui.stepTimers[variantId]`
[viewKey] — derive the countdown from `startedAt`, never re-arm a
counter, so a reload mid-cook resumes honestly. The countdown NEVER uses
the toast surface; minute ticks go through `announceCountdown()` in the
polite live region only. Finishing a cook with a timer running must ask
first. `startTimer`'s arm rule: a no-seconds press RESUMES the frozen
segment while the timer is live and RE-ARMS the armed `total` once it
has expired (never an invented 300).

The ADR-0041 GLOBAL multi-timer strip remains the RUNNING-timers surface
(visible across steps, multiple concurrent timers); the per-step card
owns only the ADD affordance.

## Timer alerts (ADR-0081 amendment)

When a timer reaches zero the device alerts per settings: a synthesized
two-tone chime (Web Audio, generated at runtime — NO audio asset, NO new
dependency) and/or a vibration pattern (`navigator.vibrate`,
feature-detected, graceful no-op). The live-region announcement STAYS —
the alert adds channels, never replaces.

- Settings → "Timer alerts": Sound and Vibration toggles
  (`ui.timerAlertSound` / `ui.timerAlertVibrate`), both DEFAULT ON.
  Persisted in the existing `mealime-planner:v1:ui` slice, so backup
  carries them (no new slice).
- DELIBERATELY DEVICE-LOCAL, never room-synced (ADR-0037's reasoning):
  sound/vibration are per-device capabilities; one household member must
  not configure another phone's alerts.
- Autoplay discipline: the AudioContext is created/resumed lazily at the
  Start-timer press (the user gesture); without a prior gesture the
  chime degrades silently to announcement + vibration — never an error.
- `MAX_TIMER_SECONDS` (21,600 s) must stay in lockstep with
  `scripts/extract_timer_hints.py` — change both together (see
  data-pipeline.md).
