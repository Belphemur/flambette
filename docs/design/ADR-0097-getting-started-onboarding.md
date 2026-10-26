# ADR-0097: Getting started onboarding tour

Status: accepted (2026-10-24)

## Context

A first-time visitor to flambette.app lands on the home hero (ADR-0096) with no
orientation to the five surfaces or the search → plan → grocery loop. The app
has zero onboarding: the first-time state is implicit and learned by poking.
The owner wants a dismissible, restartable, gamified walkthrough that
showcases searching a recipe, adding it to the plan, and viewing the derived
groceries, then optionally invites the household — all as overlays, never a
sixth tab (ADR-0016) or a new route.

The design was mocked first in Google Stitch, Flambette Recipe App project
**2725470430841257407** (Warm Culinary Paper theme), screens
"Flambette — Welcome Modal Onboarding",
"Flambette — Onboarding Step 2: Search a recipe",
"Flambette — Onboarding Step 3: Add to plan (Desktop)",
"Flambette — Onboarding Step 4: See your groceries (Desktop)",
"Flambette — Onboarding Step 5: Journey Complete (Desktop)".

The obvious third-party option — `v-onboarding` (Popper.js spotlight tours)
— was rejected: it pulls a runtime dependency we do not already carry, it
renders its own popover chrome that would fight the Warm Culinary Paper token
grammar, and it duplicates what `AppModal.vue` already owns
(teleport, focus trap, Escape/scrim, z-stack). The repo's standing rule
(`AGENTS.md`) is "no new runtime deps without surfacing the trade-off," and
the last time a dependency was a candidate (ZIP in backup) it was hand-rolled
instead (ADR-0013). Per the coding-philosophy priority, DRY wins: the
knowledge "how an overlay works" lives once in AppModal.

## Decision

1. **Build the tour, do not import a library.** A new
   `OnboardingOverlay.vue` composes the existing `AppModal.vue` as its shell
   and renders one step at a time. Spotlight targeting annotates `data-test`
   selectors (the search field, a recipe card, `add-to-plan`, the grocery
   progress bar) with a CSS cutout + anchored step card; no Popper, no new
   dependency. `prefers-reduced-motion` suppresses the halo pulse.

2. **Device-local, not room-synced.** A new `useOnboardingStore`
   (`mealime-planner:v1:onboarding`) holds `{ active, currentStep,
   completedSteps, dismissedForever, rewards }`. Onboarding is personal state
   by definition — a household member must not trigger another device's tour
   (same reasoning as ADR-0037's device-local timer alerts and ADR-0081's
   `pillDismissedRecipes`). The store is NEVER part of the room sync payload.

3. **Five steps + a completion card; household invitation folded into the
   final card.** The flow is Welcome → Search a recipe → Open a recipe →
   Add it to the plan → See your groceries → Completion. The household step
   is NOT a separate spotlight overlay (one less mount hop, and the
   celebration card is the natural place to say "now share it"); it earns a
   stamp only if the user actually starts a room. Each step auto-completes
   when the real interaction fires while the tour is active, and every step
   card offers a "I have done this — skip ahead" text control.

4. **Gamification as stamps, not a points economy.** Five collectible stamps
   (First taste, Sharp eye, Curious cook, Planner, Provisioner) render as
   saffron-bordered (#D97706) circular badges with a tomato-red (#B3381F)
   center and a leaf checkmark — tokens that echo the food-hue family in the
   Warm Culinary Paper palette (ADR-0035). No new persistent currency; the
   stamps are derived from `rewards[]` and the completion card renders the
   full strip. KISS: the gamified surface is visual only, zero new state
   machines.

5. **Dismissible anywhere; restartable from Settings.** Escape/scrim dismiss
   (AppModal provides this for free) plus an X on every step card marks
   `dismissedForever = true` while preserving earned stamps. A new card in
   `SettingsTab.vue` ("Getting started") shows the restart affordance and the
   honest current state, and clears `dismissedForever` + rewinds to the first
   incomplete step.

6. **Backup slice registered.** The onboarding slice is added to
   `STORE_SLICES` in `src/lib/backup.ts` as `onboarding.json` (device-local,
   like settings), with validate + round-trip coverage so ADR-0013's
   registry-coverage e2e case does not fail.

## Consequences

**Amendment (2026-10-24, as-built):** Decision 1 said the overlay "composes
`AppModal.vue` as its shell". As built, it cannot: AppModal's panel is a
CENTERED dialog surface, while a spotlight tour needs a pointer-transparent
scrim with a cutout at the target and an ANCHORED step card that moves with
it. `OnboardingOverlay.vue` therefore owns its own teleport + scrim, but it
follows AppModal's discipline instead of drifting from it: it reads the new
exported `appModalsOpen()` probe from `AppModal.vue` and YIELDS Escape to
any live modal, listens in the capture phase so it owns the keypress before
view-level Escape handlers (RecipeDetail's navigate-back), and suppresses
IME-composition Escapes (keyCode 229) — the same guards this file's Escape
arbitration exists for. Scrim click dismisses on the full-screen steps
(welcome/completion); the spotlight steps use a `pointer-events: none` dim
frame so the highlighted target stays interactive (no scrim dismissal
there — the X/Skip affordances own it).

- New persisted store + a single new backup slice file; the e2e registry
  coverage case (`backup-restore.spec.ts`) now has one more slice to assert —
  it is registered in `STORE_SLICES` so the existing coverage passes.
- No new runtime dependencies; the tour reuses `AppModal`'s focus + Escape +
  scrim arbitration, so the modal-discipline e2e cases (`AppModal`-aware)
  still hold.
- The spotlight cutout computes bounding boxes from `data-test` selectors at
  mount; if a target is absent on the current route (search field only on
  Recipes, `add-to-plan` only on RecipeDetail), the tour navigates to the
  target route first — a small router guard, not a new tab.
- Dark-mode flip: the stamps and halo use token classes (`text-brand`,
  `ring-brand`, `bg-surface-raised`) so they invert with the rest of the
  shell (conventions.md).

## Alternatives considered

- **v-onboarding / vue-tour (Popper.js spotlight):** rejected — runtime dep +
  fights AppModal + off-brand styling.
- **A dedicated `/onboarding` route:** rejected — violates ADR-0016 (no sixth
  tab) and the "five bottom tabs" contract; onboarding is an overlay by
  definition (Dismissible + restartable from Settings, per the owner).
- **A persistent progress bar instead of stamps:** rejected — the owner
  chose collectible food stamps for the Warm Culinary Paper identity; a bar
  is a weaker gamified payoff and adds no information over the step indicator.
- **Household as a sixth spotlight step:** rejected — folded into the
  completion card to avoid one more mount hop; the household flow already
  has its own dedicated surface (ADR-0021/0026).

## Amendment (2026-10-25, review round 5 — completion/interaction semantics)

Qodo review on the as-built overlay surfaced five correctness gaps; this
amendment records the decided semantics:

- **The welcome step is earned by starting the tour.** The welcome card's
  "Start tour" button calls `completeStep(0)` (earns `first-taste`), not a
  stampless `next()` — otherwise index 0 is never in `completedSteps`,
  `isComplete` stays false, and every launch rewinds to welcome.
- **Stamps require the real interaction (Decision 3 made literal).** The
  search stamp fires on `input` (a typed character), never on `focus` —
  tapping the field to begin typing is not a lesson learned. The grocery
  stamp fires on a real click INSIDE the grocery list (checking an item),
  never on a timer — the overlay navigates to `/grocery` itself, so an
  appearance timer awarded `provisioner` for waiting. (The open-recipe
  step keeps its 1s grace timer: the user's own card tap is the
  interaction that produced the surface.)
- **Finish ≠ dismiss.** The completion card's buttons call a new
  `finish()` action (ends the session only) instead of `dismiss()` —
  finishing the tour must not set `dismissedForever`, or Settings shows
  "Tour dismissed" to a user who just completed it. `start()` already
  refuses a complete tour; a finish with skipped stamps resumes at the
  first incomplete step (the documented rewind behaviour).
- **One setup path per spotlight.** The `onMounted` duplicate `findTarget`
  is removed (the immediate `currentStep` watcher, flush `'post'`, is the
  sole setup path) and each step's `finish` closure refuses to act unless
  `onboarding.currentStep` still equals its step index — a stale listener
  or timer can no longer double-advance past the next step's stamp.
- **The spotlight follows its target.** `measureAndListen` scrolls the
  target into view before measuring and re-measures the live rect on
  window `scroll` (capture — scroll does not bubble but travels the
  capture path) and `resize`; cleanup removes both.
- **Backup/restore transitions (Decision 6 refined).** A backup that
  OMITS `onboarding.json` runs the slice's new `onAbsent` hook: a no-op —
  a live tour is never ended by an older backup's silence. A PRESENT
  slice restores its fields, ends the live session, and calls `start()`
  ONLY when a tour session was live at import time. An import never
  STARTS a tour that wasn't running — the welcome overlay would pop
  over the surface the user is on (e.g. Settings right after the
  import) and block the app chrome behind its scrim. Restored stamps
  surface on the next natural `start()`: a fresh boot on the recipes
  page. `start()` stays a no-op for a dismissed or complete restored
  tour either way.

## Amendment (2026-10-26, household-room migration)

Owner directive: disable onboarding for anybody already in a room (they do
not need to see it); make it a migration that checks whether the device is
in a room and, if so, sets the onboarding full as done; avoid coupling via
coding-philosophy (DRY > SOLID > KISS).

A device that is (or becomes) a member of a household room must never see the
tour - the migration marks the tour done at the moment room membership is
established, and runs for existing installs too (not just a boot-time guard).

- **Decision.** `onboarding.migrateRoomDone()` is called by the room-owning
  layer whenever `ui.householdRoom` transitions to a real room code: the boot
  auto-join (`autoJoinHousehold` in App.vue), the share-link adoption
  (`joinRoomFromLink` then `ui.setHouseholdRoom`), and the Settings
  create/join flow (`joinHouseholdRoom` plus its re-roll watcher in
  SettingsTab.vue). It reuses `dismissedForever` as the never-show flag.
- **Decoupling contract.** The onboarding store does NOT import `useUiStore`
  (or identity/room stores) and does NOT read `householdRoom`. `householdRoom`
  in the ui store stays the single source of truth for room membership - never
  mirrored, never watched from onboarding. One direction of calls only:
  room layer calls the onboarding action. The store exposes ONE new action and
  takes NO room arguments.
- **Idempotence / completeness (pinned semantics).**
  1. Boot migration: after room state settles at boot, if `householdRoom` is
     truthy AND the tour is neither complete nor already dismissed, mark done.
  2. Mid-session transition: any flow that establishes membership (Settings
     create/join, share-link join) routes through the SAME action; the tour
     ends and is marked done. Stamps already earned are preserved (dismiss
     semantics, not reset).
  3. Already complete - left alone (earned stamps + finish state untouched).
  4. Already dismissed - no-op (idempotent re-entry).
  5. `restart()` still works afterwards (it clears `dismissedForever`) - a
     room member who WANTS the tour gets it. NOTE: because `householdRoom` is
     still set, a household member who restarts the tour will have it
     re-dismissed on the NEXT boot (the migration fires again) - an accepted
     consequence of in-a-room implies no-tour that the owner can revisit.
  6. The boot route gate keeps ONE decision point (migrate, then `start()`
     is a no-op for room members) - never sprinkled across App.vue.
- **KISS - no new persisted field.** `dismissedForever` is reused as the
  never-show flag; there is no `skippedForRoom` or second boolean. The
  migration writes the SAME persisted field onboarding.json already carries,
  so `backup-restore.spec.ts` export/import expectations are unchanged (a
  backup that omits the slice stays a no-op via the existing `onAbsent` hook;
  a present slice with `dismissedForever` survives a round trip).
- **Two Restart-tour entry points.** The Settings Getting-Started card keeps
  its `onboarding-restart` button; a SUBTLER Restart-tour CTA was added to the
  About card (`settings-about-restart-tour`, text-sm text-brand hover:underline -
  Warm Culinary Paper tokens) - both reuse `restartOnboarding` and never
  duplicate the stamp-clearing logic.
- **Nav-driven start (2026-10-26, owner directive: "clicking start planning
  on the hero should trigger the onboarding").** The boot gate alone fired
  only for a DIRECT boot on /recipes - a SPA push from the home hero
  ("Start planning") never re-runs onMounted, so the tour stayed hidden
  until a hard refresh, which defeats the hero's primary route into the
  catalog. App.vue now also watches `route.name` and calls the same
  idempotent `start()` on arrival at /recipes (post-catalog `!loading`
  guard, `!appModalsOpen()` exactly like the boot gate). Room members stay
  silent with no second room check: `migrateRoomDone()` has already set
  `dismissedForever` at boot before any navigation can happen, so `start()`
  remains a no-op for them. Engaging the Welcome step ("Start tour") is
  what earns the `first-taste` stamp - unchanged.
- **Not room-synced.** Onboarding data is device-local; the migration adds
  nothing to the room-sync payload or STORE_SLICES merge semantics.
