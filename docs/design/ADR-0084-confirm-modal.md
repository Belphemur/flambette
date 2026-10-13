# ADR-0084: Confirmations are modals — one slim ConfirmModal, the toast demoted to status

Status: accepted (2026-10-13)

## Context

The app's black toast pill (`App.vue`, `bg-surface-dark … rounded-full`,
fixed above the bottom nav) carries two jobs it was never shaped for:

1. **Confirm prompts.** `confirmToast` (`src/composables/useConfirm.ts`)
   is the shared confirm funnel for three destructive decisions — the
   grocery clear (explicit button on GroceryTab AND ShopView, plus the
   auto-trigger when the last item is checked), PlanTab's leave-room,
   and SettingsTab's leave-household. As a prompt surface it fails in
   practice: a 10 s auto-dismiss can make the question disappear before
   it is answered (the guard survives, the user's intent does not),
   the pill crams two uppercase actions beside a message, and the
   dark `bg-surface-dark` surface is off the Warm Culinary Paper
   grammar (level-2 elevation is `bg-popover` + `border-border`, per
   the FilterDropdown/IngredientAutocomplete popovers).
2. **Status messages.** Result toasts ("Grocery list cleared…",
   "Copied…", sync failures) — these are fine as toasts, but the same
   black pill makes every status read like an alert.

Separately, `CookingView.confirmTimerBeforeLeaving()` still uses the
NATIVE `window.confirm()` (the OS dialog) for leaving a cook with
running timers — the exact surface ADR-0072's "never native
`confirm()`" rule exists to prevent, predating that rule.

And the household auto-join toasts `Household sync active — CODE`
(ADR-0019 decision 2) on every launch — a standing reminder of a state
the room chip already displays, which the owner ruled (2026-10-13)
should not exist. Its comment claims it doubles as the share
affordance, but ADR-0079 already added `roster-share` on the room
chip's roster sheet and ADR-0023's share funnel lives there and in the
Plan tab — the toast's share button is a third, redundant surface.

**Owner rulings (2026-10-13):** all confirmations become modals; other
toasts stay but restyle to fit the app's style; the household-join
toast is removed entirely (share stays on the room chip / roster
sheet); the grocery "all items checked" auto-prompt survives as a
slim modal; the modal shape is a small centered card over the scrim.
Implementation goes to a supervised pi run against the committed ADR.

## Decision

1. **ONE `ConfirmModal.vue` — the slim confirm surface.** A compact
   centered card over the full-screen scrim, built on the ONE
   `AppModal` machinery (teleport, focus trap, Escape, focus restore —
   no second copy of any of it). Panel: `bg-popover border
   border-border shadow-popover rounded-2xl`, message in the body
   voice, two actions in a row —
   - **Confirm action**: for DESTRUCTIVE confirmations (every current
     call site — clear grocery, leave room, leave household, leave
     cook with timers) the action wears the `border-danger` outline
     per ADR-0072's destructive grammar. A future non-destructive
     confirm may use the brand fill; the component takes a `tone`
     prop (`'danger' | 'brand'`, default `'danger'`) so the grammar
     stays one prop, not a fork.
   - **Cancel**: always the outlined tonal action. Cancel and
     Escape/scrim mean the same thing: no.
   - Pinned hooks: `data-test="confirm-modal"` (panel),
     `confirm-action`, `confirm-cancel`. The panel is the dialog; the
     accessible name is the question.

2. **The funnel keeps ONE entry.** `useConfirm.ts` stays the single
   confirm funnel (DRY): `confirmToast` becomes `confirmModal` with
   the same call shape (`message`, `confirmLabel`, `onConfirm`,
   `onDismiss`). The prompt state lives in the ui store alongside
   `toast` (non-persisted): `{ message, confirmLabel, tone, resolve }`
   — App.vue hosts the ONE `<ConfirmModal v-if="ui.confirm">`. The
   SOLID contract survives verbatim: one confirmation at a time (the
   module-level `prompting` guard), `onDismiss` fired exactly once on
   EVERY end path (Confirm, Cancel, Escape, scrim — the modal's close
   event funnels to it), so `confirmAndClearGrocery`'s settled logic
   and the toast-guard rules in conventions.md keep holding without
   re-derivation. There is NO auto-dismiss: a modal waits for an
   answer.

3. **Call sites converted, none hand-roll a dialog.**
   - Grocery clear: `confirmAndClearGrocery` keeps its auto-trigger
     watcher (all items checked → prompt) and both button sites
     (GroceryTab, ShopView) — the question becomes the modal, the
     result toast stays a toast.
   - PlanTab leave-room, SettingsTab leave-household: same funnel.
   - CookingView: `window.confirm` DELETED. The leave-with-running-
     timers path intercepts navigation, opens the modal naming the
     running timer(s) and remaining time, and completes the
     navigation on Confirm (Cancel/Escape stays in the cook). The
     "names WHICH timer" honesty rule (labels + countdown in the
     message) is preserved.

4. **Status toasts restyle in place.** The pill in App.vue swaps to
   the level-2 grammar — `bg-popover border border-border text-text
   shadow-popover` (theme-aware via the existing `--color-popover`
   dark flip) — same position, same `toast` Transition, same
   `data-test` hooks (`toast`, `<kind>-toast`, `toast-action-primary`
   / `-secondary`). No behaviour change; specs re-pin surfaces, not
   hooks.

5. **The household auto-join toast is REMOVED.** `autoJoinHousehold`
   keeps the join (ADR-0019 decision 2's join behaviour stands) and
   drops the success toast — a join that succeeded is visible in the
   room chip; the app does not announce a state the header already
   shows. The FAILURE toast (`Household sync unavailable — …`) STAYS
   (it reports something the chip does not show) and takes the new
   restyle automatically. Share surfaces after removal: the roster
   sheet's `roster-share` (ADR-0079) and the Plan tab share sheet —
   ADR-0023's "one tap, one composable" contract is unaffected.

6. **Records and docs, same change.** ADR-0019's Status flips to
   `accepted (superseded in part by ADR-0084)` — the join behaviour
   stands, the success toast does not. `docs/agents/conventions.md`'s
   toast bullet gains the confirm-modal rule: confirmations go through
   `confirmModal`, never `window.confirm()`, never a bespoke dialog;
   toasts are status-only. The PRD's cooking-mode and rooms prose
   mentions the timer-leave question and the silent join where those
   behaviours are described.

## Consequences

- The "weird black pop-up" class is gone: prompts are modals that
  wait, statuses are warm-paper toasts, the native OS dialog is dead.
- e2e re-pins: the confirm flows (`clear-grocery`, `cooking-timers`
  leave-guard legs, plan/settings leave legs) click
  `confirm-action`/`confirm-cancel` on the modal instead of
  `toast-action-*`; any spec asserting the household toast's presence
  flips to asserting its ABSENCE. Toast surfaces re-pin visual
  assertions only where they existed.
- The one-mount==one-open AppModal assumption holds: the prompt state
  is a single reactive slot in the ui store, so App.vue's host is
  mounted exactly while a question is open.
- **Stacked modals settle one at a time.** A confirm can open OVER
  another AppModal (leave-room over the share sheet, an inbound-grocery
  confirm over the changelog). Escape and Tab belong to the top-most
  open modal only (AppModal's module-scope `openModals` stack), and the
  modal that consumes an Escape stops sibling `window` listeners with
  `stopImmediatePropagation()` — `stopPropagation()` cannot arbitrate
  listeners on the same target, so one Escape ends exactly one dialog
  and never re-processes in a view handler registered after the modal's.
- **A session's question dies with the session.** CookingView's
  timer-leave prompt lives in the app-level slot, so the session tracks
  its outstanding question (`confirmLease`) and settles it on unmount:
  a browser/system Back while the modal is up ends the prompt with the
  session instead of stranding a stale `complete` (router.back() from
  the wrong page, a mark-cooked on an abandoned recipe) over whatever
  page the user landed on.
- Two-phone onboarding loses the toast's share button; the roster
  sheet (room chip) is now THE surface that hands a new device the
  link — the join-congrats modal (new joiner) already shows the code.
- A status toast and an open confirm modal can coexist? No — the
  confirm funnel routes through the ui store's single-prompt slot;
  showing a status toast does not displace an open modal (different
  state slots), and answering the modal resolves the guard the same
  instant the result toast fires.

## Alternatives considered

- **Restyle the confirm toast in place** (keep toasts, fix colours):
  rejected by owner ruling — the failure mode (auto-dismiss losing a
  question) is structural, not cosmetic.
- **Per-site modal dialogs** (GroceryTab owns one, CookingView owns
  one): DRY violation — four copies of a11y machinery is exactly what
  AppModal was extracted to end (its header documents four drifted
  copies historically). One funnel, one host, one surface.
- **Bottom-sheet confirm**: rejected by owner — a small centered card
  over the scrim was ruled the shape.
- **Keep the household join toast, drop only its share button**:
  rejected by owner — the reminder itself is noise; the chip is the
  standing indicator.
- **Async-native replacement for `window.confirm` returning a
  Promise** (await a modal from the route guard): considered for
  CookingView and rejected — `onBeforeRouteLeave` guards are
  synchronous in Vue Router's contract with this app's leave flow;
  intercept-and-resume keeps the guard pure and the modal declarative.

## Addendum (2026-10-13, toast ergonomics): the status pill gets room and time

Owner ruling on the shipped pill: "the toast can be longer instead of
being so squished and stay a little longer on the screen." Two
behaviour changes against decision 4's "no behaviour change" —
recorded here so the decision and the shipped app agree.

- **The pill gets room.** `px-4 py-2` → `px-5 py-3`, and the fixed
  pill gains `max-w-[min(28rem,calc(100vw-2.5rem))]`: a 28rem (448px)
  cap on desktop, full width minus gutters on a phone. `rounded-full`
  becomes `rounded-3xl` — at a single line the 24px radius still
  reads as the same capsule, but a wrapped message becomes a rounded
  card instead of a tall narrow capsule. The row turns
  `flex-wrap justify-center` with `leading-snug` on the message: short
  toasts render exactly as before (one line, actions beside the
  message), while long ones let the text wrap and drop the actions to
  a centred line below instead of squeezing them beside the text.
  Position (`bottom-24`, centred), the level-2 tokens and the
  `data-test` hooks are untouched.
- **The default dwell is 2500 → 4000 ms.** Four seconds is a
  comfortable read for a status line and matches the platform norm
  (Material snackbar). It deliberately stays UNDER Playwright's 5 s
  default expect timeout so every spec that awaits a toast's absence
  still resolves inside its timeout; call sites with an explicit
  `duration` (2000 quick acks, 6000–8000 failure messages) keep their
  value — only the default moves.
- **The empty `<Transition name="toast">` gets its motion.** The
  transition classes shipped with no `.toast-*` CSS, so toasts popped
  in place with no motion at all. `src/style.css` adds a subtle
  fade + 12px rise (180ms ease):

  ```css
  .toast-enter-active, .toast-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
  }
  .toast-enter-from, .toast-leave-to {
    opacity: 0; transform: translateY(12px);
  }
  ```

  The motion composes with the pill's Tailwind centering because
  Tailwind v4 emits `-translate-x-1/2` as the CSS `translate`
  property, and the CSS `transform` applies AFTER `translate` — the
  rise rides on top of the horizontal centring and never displaces
  it. Under `prefers-reduced-motion: reduce` the rise is dropped and
  the fade remains, matching the buttons' reduced-motion contract in
  `style.css`.
