# ADR-0103: "Used" ingredient checks persist across the cooking surfaces

Status: accepted (2026-11-26)

Numbering reservation: 0103 taken from `build_adr_index.py --next` on a
fresh `695ed024` checkout, after an all-branch scan (max in-flight record
ADR-0102, no open PRs).

## Context

Owner ask (2026-11-26): "In cooking mode or even in the steps of the recipe
I should be able to check the checkbox for saying I used that ingredients."

Measured against the code at `695ed024`:

- **Cooking mode** already renders the ADR-0081 "This step uses" checklist
  with real checkboxes (`measured-check`), but the checked state is
  DELIBERATELY ephemeral: `CookingView.vue` holds it in a plain `Set` ref
  and wipes it on every step-view change (ADR-0081 decision 2's
  "checked state is per-step ephemeral view state" clause, enforced by the
  `viewKey` watcher). The owner's tick on step 3 does not survive walking
  to step 4 and back.
- **Recipe detail** renders the same ADR-0022 measured amounts under each
  step as STATIC chips (`detail-measured-chip`) — display-only, the
  ADR-0022 presentation cooking mode superseded. There is nothing to
  check on the detail steps at all.

The owner's intent is that "I used that ingredient" means something that
persists: a tick on one surface is visible on the other, and it survives
walking between steps — it is a usage record for the cooking occasion,
not scratch state.

No new Stitch render was generated for this record: the presentation is
ADR-0081's existing owner-approved checklist rendering (project
`2725470430841257407`, "Flambette — Cooking Mode (Mobile Step View)" /
"(Desktop)"), re-applied to the detail steps verbatim. This is a
state-semantics change over an accepted design, not a new surface.

## Decision (owner-binding)

1. **One SESSION/VIEW-SCOPED "used" record per recipe visit. NO persistence.
   ** The checked set lives with the recipe visit, never in a store slice:
   cooking mode holds it in the cooking session (surviving step
   navigation WITHIN the session — the per-step wipe was the defect), the
   detail sheet holds it in a component ref cleared when the sheet
   changes recipe (ADR-0073's prep-card reasoning, extended to the step
   rows). Nothing survives mark-cooked, an app restart or a re-visit:
   the user may re-cook the recipe another time and expects a clean
   sheet. Device-local by construction — no store change, no room
   payload, no backup slice.
2. **ONE canonical key function, shared by both surfaces.** The key is
   derived from the `measuredAmounts` output as
   `stepIndex:lineIndex:ingredient-nameKey` in a shared lib accessor;
   `CookingView`'s per-step `chipKey` and `RecipeDetail`'s step chips both
   call it. The key NEVER contains the rendered quantity — the detail
   page live-scales its chips with the servings stepper, so a
   quantity-bearing key would orphan a check the moment servings change
   (ingredient identity is stable, the rendered amount is not). A check
   made on detail renders checked in cooking mode, and vice versa. A
   second derivation that answers the same question differently is the
   ADR-0081 defect class (the observed two-predicates timer
   disagreement) — never ship two.
3. **Presentation unchanged (ADR-0081 rows, ADR-0072 colours).** Cooking
   mode keeps the "This step uses" card exactly as shipped. On detail,
   each step's measured-amount chips become the SAME interactive checklist
   rows — full-row tap targets, 20px rounded checkbox, success green fill
   + struck-through muted text when checked — replacing the static chip
   list. The derivation is untouched: same `measuredAmounts.ts` source,
   same nameKey matching, same no-invented-quantity rule, same scaling
   import.
4. **NOT cleared by mark-cooked — there is nothing to clear.** The set
   dies with the visit itself: session end / sheet change / reload wipes
   it, so a later re-cook starts clean by construction. `recordCook()`
   is untouched (the ADR-0083 one-path ruling stands; this record adds
   nothing to it).
5. **data-test pins.** Cooking keeps `measured-check` (semantics survive);
   the detail rows take `detail-measured-check` mirroring the
   `detail-measured-chip` hook it replaces. New e2e: checks survive step
   navigation within one cooking session; a detail tick is visible when
   entering cooking from that detail sheet; NOTHING survives a re-cook
   or an app reload.

## Consequences

- ADR-0081's decision 2 ephemeral clause is superseded IN PART (its
  presentation ruling stands untouched): the per-STEP wipe is retired in
  favor of a session-scoped set, but nothing persists beyond the visit.
  The record's Status line is flipped to record that.
  `docs/agents/cooking.md`'s checklist bullet is reworded in the SAME
  change — it currently teaches the per-step ephemeral rule.
- ADR-0073's "the checklist is ephemeral" clause is UNTOUCHED: it rules
  the detail PREP card (`readyIngredients`), which stays per-sheet
  ephemeral. The step rows are a different component with different
  semantics; this record is their state authority.
- The cooking e2e suite re-pins: the per-step clear is replaced by
  session-persistence assertions (checks survive step navigation, die
  with the session); the detail step specs gain the checkable rows.
- No store change, no backup/restore surface, no relay change, no
  migration, no new runtime dependency.

## Alternatives considered

- **Room-synced used state** (a new synchronized store): rejected — a
  household does not share "I added the salt" mid-cook; the payload cost
  and the add-store surface (relay core + per-store migrations on both
  runtimes) buy nothing. If the owner later wants household visibility,
  that is a new record, not an amendment here.
- **Never persists across visits**: rejected mid-flight by the owner
  (2026-11-26): a persisted per-recipe used-set was drafted, then
  withdrawn — the user may re-cook the recipe another time and expects a
  clean sheet, so the checked set is session/view-scoped (decision 1).
  The superseded wording ("cleared by recordCook on mark-cooked") was
  never implemented against; the store-based draft was removed in the
  implementation round before any PR landed.
- **Never auto-clear with explicit reset only**: rejected — the record's
  meaning is per-occasion; a stale "used" from last Tuesday reading as
  current is exactly the dishonest-state class the timer card was fixed
  for (ADR-0081's one-predicate ruling).
- **Keep cooking ephemeral, persist only on detail**: rejected — the
  owner named cooking mode FIRST; two different lifecycles for the same
  checklist would need the one-key rule anyway, and the ephemeral variant
  is the sub-case that loses information.

## Decision log (coding-philosophy: DRY > SOLID > KISS)

- **DRY** — one canonical key function with two consumers: duplicate
  derivations let the surfaces disagree, the exact defect ADR-0081
  documented and fixed on the timer card.
- **KISS** — plain component/session state over any store slice: no
  persistence machinery at all, and ADR-0073's own reasoning (personal
  state stays local and dies with the visit) applies unchanged.
- **SOLID** — the session/sheet owns its own set lifecycle; `recordCook()`
  is untouched, so no cross-module coupling was added.
