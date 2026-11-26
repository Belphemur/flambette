# Cooking mode (ADR-0020 → ADR-0081)

The cooking view is the immersive kitchen surface (`/cooking/:id`): one
step at a time, inside the 672px `max-w-reading` measure (ADR-0073 — a
step read at arm's length wants a measure, not a page).

## Composition (ADR-0081, the current contract)

Top to bottom: slim header (recipe title one-line truncate, mono progress
line `serves N · Step i / n`, thin tomato progress bar, close), the STEP
TEXT as the dominant element (20px/30px mobile, 22px/34px desktop), then
two cards, then the action deck.

- **Checkable step detail lines (ADR-0103, final owner ruling
  2026-11-26)**: the checkbox target is the AUTHORED DETAIL LINE under the
  step text — the row that used to carry a decorative `aria-hidden` box.
  Every line matching >=1 `line_item` becomes a full-row tap target with
  a REAL sr-only `<input>` inside a `<label>`: 20px rounded box, bold mono
  amount from the LINE ITEM + ingredient name + prose, success green fill
  and struck-through text when checked (ADR-0072). PRECISE lines are
  checkable too; a line with no match stays plain prose (no fake
  affordance). There is NO separate "This step uses" card in cooking —
  the prose list IS the checklist (`measured-check` / `measured-chip`).
  `checklistChipsForLines` widens the ADR-0022 derivation to all matched
  lines; `measuredChipsForLines` keeps the narrow imprecise-only rule for
  other consumers. One canonical key
  `stepIndex:lineIndex:ingredient-nameKey` from the BASE name (never the
  rendered amount or the restriction-substituted display name) drives
  both surfaces.
  Cooking's used-set is DEVICE-LOCAL in the ui store's persisted slice,
  keyed by recipe id + `{startedAt, usedKeys}`: it survives step nav and
  a mid-cook reload, expires at READ TIME after 24h (no sweeper), and the
  ONE `recordCook()` path clears it. Detail is fully EPHEMERAL: one plain
  component ref shared by the step rows AND the prep-card ingredient rows
  (`MeasuredChip.itemId` bridges the two keys); Start cooking hands the
  step keys into the session once and discards the sheet's copy. Switching
  recipe clears it. No room payload, no new backup slice.
  Both surfaces give the row a visible keyboard-focus ring
  (`.used-ingredient-row` in `src/style.css`): the `<input>` is `sr-only`,
  so the global input-only `:focus-visible` outline alone is invisible.
  The ring uses the same `brand-text` token and `:has(:focus-visible)`, so
  pointer taps stay unringed.
- **One recipe id = one session**: the app shell keys `CookingView` by the
  `/cooking/:id` param. A param-only route change remounts the component
  (fresh document, servings, plan provenance and cook record); moving
  inside one recipe keeps the same instance. The persisted used-set is
  keyed by that same id, so returning within 24h resumes it and a stale
  entry starts clean.
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
- **"This step uses" checklist card**: the ADR-0022 measured-amount chips
  are superseded in PRESENTATION ONLY by interactive checklist rows —
  full-row ~56px tap targets, 20px rounded checkboxes, bold mono amount +
  ingredient name; checked = success green fill + struck-through muted
  text (ADR-0072: completion is the success family, NEVER a food hue, on
  a checkbox). The DERIVATION is untouched — same `measuredAmounts.ts`
  source, same nameKey word-boundary matching, same no-invented-quantity
  rule, same scaling import. Checked state is a SESSION-scoped set that
  survives step navigation within one cooking session and dies with the
  visit (ADR-0103, superseding the per-step ephemeral clause): one
  canonical key function shared with the detail page's step rows;
  NOTHING persists across mark-cooked, a re-cook or an app reload.
- **"Timers for this step" card — ONE collapsed disclosure
  (ADR-0081 addendum 2026-11-26)**: the bottom strip's chip is the ONE
  always-visible timer surface, so this card no longer duplicates a live
  countdown. Its ~56px header summarises the state — a live timer by
  count + label + countdown, a hint as "Detected: N min — label", or
  "Set a Timer" / "No timer running for this step." — and stays collapsed
  in EVERY presence state (including a running timer and a detected hint).
  An explicit tap expands the Restart/Cancel rows for defined timers; a
  second explicit "Set another timer" tap reveals the creation form
  (direct when none is defined). Arming collapses it again. No timer state
  or `data-test` timer hook changed, and every verb stays reachable.
  - **ONE presence derivation (DRY)** consumes BOTH the ADR-0041 hint
    resolution AND `ui.stepTimers`: `src/lib/timerPanel.ts` owns the
    summary and visibility shape, pinned by unit tests. A second
    derivation answering the same question differently is a defect (the
    original preview bug showed "no timer" beside "Detected: 10 min").
  - The saffron "No cook time mentioned in this step — set one if needed."
    banner NEVER renders while a timer exists. Presets are labelled
    quick-start affordances, never presented as detections; no invented
    durations.
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
- **The detail page is a cooking surface (ADR-0098)**:
  RecipeDetail holds a best-effort Screen Wake Lock (`'screen'`) while
  the page is open — `onMounted` acquires it, `onUnmounted` releases it,
  and a `visibilitychange` listener re-acquires when the tab returns to
  visible. This is the SAME ADR-0020 pattern CookingView ships: silent
  no-op when the API is absent or denied (private tab, unsupported
  browser, cross-origin iframe) — the detail page still renders and the
  cook flow is untouched. Active on both layouts (harmless on desktop;
  the API is mobile where it matters). Pinned by
  `e2e/detail-wakelock.spec.ts`.
- **The detail mark: desktop pill / mobile inline CTA (ADR-0098,
  superseding ADR-0083's mobile rendering)**: the floating
  "Cooked this?" pill (ADR-0083 addendum, owner pill-round rulings
  2026-10-13) is DESKTOP-ONLY as of ADR-0098 — the pill is gated by
  `isDesktopLg` (`min-width: 1024px`) in `cookedPillVisible`, so it
  never renders on mobile. RecipeDetail renders the compact pill from
  the Stitch render ("Recipe Detail End (Mobile Dark)", Warm Culinary
  Paper) FLOATING, exactly as
  Stitch designed — ONE pill `fixed` to the viewport at the content's
  right edge (~120px above the bottom nav via
  `bottom-[calc(120px+env(safe-area-inset-bottom))]`, `z-40`,
  `bg-surface-raised`, subtle `border`, the one popover shadow, warm
  brand accent dot) behind a `pointer-events-none` wrapper with an
  app-width column (the ADR-0049 hit-testing lesson; on desktop the
  pill sits on the content's right edge, not the viewport's). NOT
  HOOKED TO ANYTHING: no title-row button, no handoff — content scrolls
  under the pill while it stays put; the wrapper carries
  `will-change-transform` because Firefox repaints a fixed element on
  the main thread during scroll unless it owns a compositor layer (the
  owner-reported "pill is moving" drift; Chromium layout probes show
  zero delta). TRIGGER = the TAIL SENTINEL: a function-ref sentinel
  riding the THIRD-FROM-LAST step (index `length - 3`) observed with
  `useIntersectionObserver` at threshold 0, PLUS a passive,
  rAF-throttled scroll/resize/visibility evaluator — the observer never
  fires in hidden or occluded tabs (proven on this branch), so the
  fallback computes the same "sentinel inside the viewport" truth from
  scroll events; both writers converge, the observer stays the fast
  path. ALWAYS OFFERED: the pill renders on every visit once the
  sentinel is met — recipes cook repeatedly, so the cooked-today
  suppression is RETIRED (owner: "since a recipe can be cooked multiple
  times we should see the pill all the time"). ICON-ONLY (kept from the
  icon-static ruling): the dot + one CookingPot glyph (ChefHat stays
  the Start-cooking CTA) — the accessible name `Cooked this?` carries
  the words. DESKTOP (owner rulings 2026-10-14): at `xl`+ the pill
  TRANSLATES OUTSIDE the 1100px app container into the free page
  margin — `xl:translate-x-[calc(100%+40px)]` puts its left edge 1.5rem
  past the container's right edge, so it floats BESIDE the instructions
  column and can never overlay the step text — while
  `lg:bottom-[110px]` floats it ~110px above the bottom (mobile keeps
  120px + safe-area). The margin holds the ICON-ONLY pill below `2xl`;
  the FULL text label ("Cooked this?") appears from `2xl`, where the
  margin is wide enough for it. THE PALETTE NEVER CHANGES PER LAYOUT:
  raised surface (`bg-surface-raised`), subtle `border-border`, the one
  popover shadow, the brand accent dot, the brand-text pot glyph and
  the `text-text` label — the brand-fill/white-text overrides tried the
  same day were REJECTED by the owner and reverted. PROMPT = the pot WIGGLES, pulsing: 5 rounds of a 2 s
  wiggle (`WIGGLE_MS`), pauses between rounds growing 2/4/6/8 s
  (`WIGGLE_PAUSES_MS`), then it stops for that page load (~30 s); the
  scoped keyframes rotate ONLY the svg (±8°, 0.5 s cycles,
  `transform-origin: center`; button/dot/LABEL/layout never transform
  — the desktop text label is deliberately excluded from the
  animation) and
  are disabled under `prefers-reduced-motion: reduce`; the wiggle is
  decorative, the aria-label unchanged. DISMISS = a flick beyond ~24px
  (`PILL_DISMISS_PX`) in ANY direction dismisses the pill FOR THAT
  RECIPE persistently — a device-local record in the ui store's
  persisted slice (`pillDismissedRecipes`, the ADR-0081 device-local
  family; never the room payload, never a backup slice); pointer
  capture + `touch-action: none` keep the gesture, and a latch eats
  the synthetic click so a dismiss never records a cook. Movement under
  the threshold is a TAP: it records through the ONE `plan.markCooked`
  path (captures the prior exactly like the session does) and raises
  the SAME `PostCookPrompt` over the detail page: Done → `/history`;
  Undo → record removed and the user STAYS on detail. `data-test`:
  `cooked-pill` (desktop) + `detail-cook-cta` (mobile).
  Pinned by `e2e/cooked-pill.spec.ts` (Desktop Chrome asserts the
  floating pill, Pixel 7 asserts the inline CTA) and the auxiliary
  Firefox runner `playwright.pill-firefox.ts` (CI installs chromium only).

  MOBILE INLINE CTA (gated `v-if="!isDesktopLg"`, rendered in-flow
  immediately after the `</ol>` step list; the `lg:hidden` class only
  guards the prerendered first paint): a full-width tonal button — `h-11`,
  `rounded-xl`, `border-success/25 bg-success/8 text-success`, one
  `CookingPot :size=16` — labelled "Mark as cooked" (the cooking
  session's in-flow label, NOT "Cooked this?"). ALWAYS offered once
  the doc loads: no sentinel, no wiggle, no dismissal, no cooked-today
  guard — it can be pressed repeatedly, each press records another cook
  and re-raises the SAME prompt. It calls the same single
  `recordCookFromDetail()` path the desktop pill uses (extracted from
  `cookFromPill()`), so the prior-capture and Undo semantics are
  identical: Undo removes the record and the user stays on the detail
  page with the CTA still present.
- Rejected render fictions: the "ACTION STEP" badge, difficulty labels,
  est-times beyond the recipe's own minutes.

## Timer semantics (ADR-0020 — untouched)

ONE timer per step VIEW (a Meanwhile pair is one view, ADR-0010), stored
as `{remaining, running, startedAt}` in `ui.stepTimers[variantId]`
[viewKey] — derive the countdown from `startedAt`, never re-arm a
counter, so a reload mid-cook resumes honestly. The countdown NEVER uses
the toast surface; minute ticks go through `announceCountdown()` in the
polite live region only. Finishing a cook with a timer running must ask
first — the ONE confirm modal (ADR-0084), never `window.confirm()`: the
leave is intercepted, the modal names the running timer(s) with
remaining time, and Confirm completes the leave (Cancel/Escape stays in
the cook). `startTimer`'s arm rule: a no-seconds press RESUMES the frozen
segment while the timer is live and RE-ARMS the armed `total` once it
has expired (never an invented 300).

The ADR-0041 GLOBAL multi-timer strip remains the RUNNING-timers surface
(visible across steps, multiple concurrent timers). Since the 2026-11-26
addendum the per-step card owns only the DISCLOSED manage/add affordance:
its collapsed header summarises a timer but never renders a second live
countdown beside the strip's chip. The `ui.stepTimers` shape, the
countdown derivation and the manage sheet are unchanged.

## Timer alerts (ADR-0081 amendment; recurring alarm per ADR-0093; visual floor per ADR-0104)

When a timer THIS session watched count down reaches zero, the device
alerts in ROUNDS (ADR-0093): each round is a synthesized two-tone chime
(Web Audio, generated at runtime — NO audio asset, NO new dependency)
and/or a vibration pattern (`navigator.vibrate`, feature-detected,
graceful no-op), each channel honoring its toggle read live. ADR-0104
adds a THIRD channel: a SHAKE on the shell's global alarm banner and on
the alarming timer's chip in the cooking strip, driven from the SAME
reactive `alarmingTimers` mirror (no new polling, no new store, no new
persisted key). The visual channel is ALWAYS ON and has NO toggle — it
is the channel that cannot fail where Brave/Android blocks audio and
haptics. The pause AFTER a round GROWS — 2 s, 4 s, 8 s, 16 s, then a
30 s cap — and the alarm repeats UNTIL THE USER STOPS THE TIMER:
Restart/Resume re-arms (the countdown is live again), Cancel/Clear
removes the timer. NO new control exists; finishing the cook does NOT
silence an alarm — only stopping the timer does. A timer already
expired when the session first saw it never alarms (the ADR-0081
seeding rule stands). The live-region announcement STAYS — the alert
adds channels, never replaces. The ONE 1 s host interval
(`src/lib/timerAlertHost.ts`) is still the scheduler (the tick checks
which rounds are due — no per-round timers), and its loop stays alive
while any timer is alarming even though nothing is counting.

**Visibility tick (ADR-0104)**: a backgrounded tab's interval can be
throttled (≥1/min) or frozen, so the deadline may pass unseen. The
host arms ONE `visibilitychange` listener with the loop's lifecycle and
runs `tick(Date.now())` immediately on `visible` — round 1 (or the next
due round) lands the moment the cook looks, with the shake making it
unmissable. The listener is removed by `stopTimerAlertHost`, so no tick
can run against a stopped host; when the listener is armed while the
loop is stopped, the visible edge takes the same ensure-entry an arm
press uses. CSS keyframes carry the shake; `prefers-reduced-motion:
reduce` replaces motion with a static brand outline, and all colours
come from the token-based theme flip (no `dark:` pairs).

Review hardening (ADR-0093 change note 2026-10-19, all four real):
(1) the shell shows a GLOBAL alarm banner (`alarm-banner` in App.vue)
while any timer rings — `Time's up — still ringing: …` + **Stop** — on
every non-fullscreen surface, because the strip's stop verbs are
unreachable after Finish (Done lands on /history); Stop performs the
timer's own Clear verb (NO new alarm state — ADR-0093's rejected
"silence button" stays rejected); hidden on cooking/shopping, which mount
  ONE recipe-agnostic fullscreen indicator (`fullscreen-alarm`,
  ADR-0104 change note 2026-11-26) off the same `alarmingTimers` mirror.
  That indicator lists/Stops EVERY alarming timer, so an alarm from another
  recipe (cooking's strip is recipe-scoped) or one that expired while
  shopping still has the visual floor and a reachable Stop; no foreign
  chip is added to the current recipe's strip.
(2) the alarm is pinned to the record's run-segment fingerprint, so a
backup restore re-creating the same ids drops the old alarm instead of
inheriting its rounds (a rename keeps it; a Pause IS a stop).
(3) the pitch ordinal is CAPTURED at round 1 — clearing a lower-id
timer never moves a ringing alarm to another voice.
(4) was RE-SCOPED by ADR-0104: with BOTH ENGINE channels dead (sound
off; vibration off or API absent) the alarm still enters and stays in
the alarming set — the banner + shake are the output, rounds keep
escalating, and only the user's stop ends them. The both-channels
`channelsLive` predicate now gates only the chime/vibration `fire()`
call; the toggle-flip-is-a-user-stop rule no longer applies to the
visual floor. The banner is no longer merely a display of an audible
alarm — it IS one of the alarm's outputs.

- Settings → "Timer alerts": Sound and Vibration toggles
  (`ui.timerAlertSound` / `ui.timerAlertVibrate`), both DEFAULT ON.
  Persisted in the existing `mealime-planner:v1:ui` slice, so backup
  carries them (no new slice). Where `navigator.vibrate` is NOT a
  function (Firefox ≥ 129 removed the API — Bugzilla 1900037, inert
  since 79 per Bugzilla 1653318; no iOS browser ever exposed it), the
  Vibration row shows an inline "this browser cannot vibrate" note
  (`timer-alert-vibrate-unsupported`) and the toggle is disabled in
  place; the stored preference is KEPT untouched. A one-line note
  (`timer-alert-visual-note`) says the banner/chip shake is ALWAYS on
  and cannot be turned off — there is deliberately no third toggle.
- PER-TIMER PITCH (ADR-0093): the chime is transposed by the timer's
  ORDINAL among its recipe's timers (the strip's order, oldest id
  first) — semitone offsets 0/+2/+4/+7 for timers 1–4, bounded by
  `MAX_CONCURRENT_TIMERS`, every tone of the A5→D6 pair shifted so the
  rising interval is preserved (`freq = base * 2 ** (st / 12)`). The
  host derives the ordinal at fire time; the engine stays pure.
- DELIBERATELY DEVICE-LOCAL, never room-synced (ADR-0037's reasoning):
  sound/vibration are per-device capabilities; one household member must
  not configure another phone's alerts.
- Autoplay discipline: the AudioContext is created/resumed lazily at the
  Start-timer press (the user gesture); ADR-0104 ALSO retries
  `ctx.resume()` at FIRE time when the context is not `running` (Brave
  can leave the unlocked context suspended), playing as soon as it
  reaches `running`. A rejected/failed resume degrades silently to the
  other channels — never an error, never the alarm's only path.
- `MAX_TIMER_SECONDS` (21,600 s) must stay in lockstep with
  `scripts/extract_timer_hints.py` — change both together (see
  data-pipeline.md).
