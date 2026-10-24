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
