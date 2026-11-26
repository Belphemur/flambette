# ADR-0103: "Used" ingredient checks on the step detail lines

Status: accepted (2026-11-26)

Numbering reservation: 0103 taken from `build_adr_index.py --next` on a
fresh `695ed024` checkout, after an all-branch scan (max in-flight record
ADR-0102, no open PRs).

## Context

Owner ask (2026-11-26): "In cooking mode or even in the steps of the recipe
I should be able to check the checkbox for saying I used that ingredients."
Owner clarification (2026-11-26, after seeing the PR-120 preview): the
checkbox the owner meant IS the one already drawn next to each step's
detail lines — the decorative `aria-hidden` checkbox spans in the
step-prose ingredient list, which have LOOKED clickable since ADR-0022
while doing nothing.

Measured against the code at `695ed024`:

- **Cooking mode** renders the step text followed by its detail lines as
  `<li>` rows with decorative checkbox spans (`CookingView.vue` per-view
  detail list) — no input, no label, no handler. Separately, the
  ADR-0081 "This step uses" card renders real checkboxes
  (`measured-check`), but only for IMPRECISE detail lines (the ADR-0022
  gate: a chip exists only where the line's own quantity fails to
  parse) — and the checked state is deliberately per-step ephemeral
  (ADR-0081 decision 2). For a recipe whose lines are all precise
  (measured against the real catalog: recipe 5995's 17 steps, reproduced
  live on the preview at head `4938301`), the card renders on NO step,
  and the only visible checkboxes are the decorative ones.
- **Recipe detail** renders the same per-step detail lines with the same
  decorative checkboxes, and the measured amounts as STATIC chips
  (`detail-measured-chip`) — display-only.

The owner's intent: every step-detail ingredient line with a matched
catalog line item is a checkable "I used that" row — ticked state lives
for the recipe visit, on both surfaces.

No new Stitch render was generated for this record: the presentation is
ADR-0081's existing owner-approved checklist rendering (project
`2725470430841257407`, "Flambette — Cooking Mode (Mobile Step View)" /
"(Desktop)"), applied to the step detail lines verbatim. This is a
state-semantics change over an accepted design, not a new surface.

## Decision (owner-binding)

1. **Cooking mode remembers the used-set for the SESSION's lifetime, or
   24 hours — whichever comes first.** The cooking session's used set is
   device-local state in the ui store's persisted slice, keyed by recipe
   id and stamped with the session's start time. It survives an app
   reload or restart mid-cook (an honest resume, the same reasoning as
   the ADR-0020 timer's `startedAt` rule). It is REMOVED when the
   cooking session finishes (the one `recordCook()` path — mark-cooked
   or Finish — clears the recipe's entry) and AUTO-EXPIRES after 24
   hours: a used-set older than 24h is a dead session, and the next
   visit to that recipe starts clean. The user may re-cook the recipe
   another time; a finished or stale session never leaks ticks into it.
2. **On detail, everything is fully EPHEMERAL — component state only.**
   The detail sheet's step rows and ingredient list hold their checks in
   a plain component ref, cleared when the sheet changes recipe
   (ADR-0073's prep-card reasoning, extended to the step rows) and never
   persisted, never carried in the room payload, never a backup slice.
   Starting cooking from the sheet seeds the cooking session's set via
   the ONE one-shot handoff (then the detail's copy is discarded).
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
3. **The CHECKBOX TARGET is the step's own detail lines.** The feature
   exists to make the step-prose ingredient list interactive — the
   `<li>` rows under the step text (CookingView's per-view detail list
   and RecipeDetail's per-step detail lines), which previously carried
   only a decorative `aria-hidden` checkbox span and looked clickable
   while doing nothing. Every detail line that matches at least one
   `line_item` becomes a full-row interactive checklist row — REAL
   `<input type=checkbox>` inside a `<label>` (20px rounded box, success
   green fill + struck-through muted text when checked, ADR-0072) — for
   PRECISE and imprecise lines alike. The no-invented-quantity rule is
   untouched and stronger-scoped: a row exists only because a line item
   matched, and the row's displayed amount comes from the line item
   (confirming the prose for a precise line, supplying it for an
   imprecise one). A detail line matching NO line item renders as plain
   prose (no checkbox — never a fake affordance). On cooking mode the
   checklist lives IN the prose list — there is no separate "This step
   uses" card beside it. On detail, the step's measured-amount chips
   become the same interactive rows. The derivation is untouched: same
   `measuredAmounts.ts` source, same nameKey matching, same scaling
   import — only the imprecision gate is scoped to the row-eligibility
   rule above (matched line item = a row; the ADR-0022 imprecise-only
   gate never decided which lines may be checkable).
3b. **On detail, the step rows and the ingredient list are ONE set.**
   Ticking a step detail row also marks the matching ingredient row in
   the recipe's ingredient card (ADR-0073's prep checklist), and
   unticking unmarks it — both render from the SAME per-sheet used set,
   keyed by ingredient identity (the step rows' nameKey and the
   ingredient rows' item id resolve through the ONE shared accessor, so
   a restriction rename or a servings change cannot desynchronise the
   two views of the same ingredient). The whole linkage is fully
   EPHEMERAL — it dies with the sheet visit, exactly like the step rows
   (decision 2); nothing persists and nothing enters the grocery list
   from it. This supersedes IN PART ADR-0073's "the checklist is
   ephemeral" clause on detail: the prep card keeps its ephemerality but
   loses its separate state — it now renders from the sheet's shared
   used set.
4. **Cleared by mark-cooked; 24h TTL otherwise.** The ONE `recordCook()`
   path (ADR-0083) clears the recipe's session entry as part of
   recording: the session is finished, its ticks must not leak into a
   later re-cook. Without a mark-cook, the entry AUTO-EXPIRES after 24
   hours (decision 1) — a mid-cook reload keeps ticks, a stale session
   does not. The 24h TTL rule stands even when the entry is never
   read: expiry is evaluated at read time, so no background sweeper
   exists.
5. **data-test pins.** The interactive step-detail rows keep `measured-check`
   on cooking (the hook family the card used, now on the prose-list rows);
   the detail rows take `detail-measured-check`. The decorative
   checkbox-only spans are replaced by real inputs — an `aria-hidden`
   checkbox that does nothing is an interaction lie and never ships. New
   e2e: checks survive step navigation within one cooking session AND an
   app reload while the session is under 24h old; a re-cook after
   mark-cooked starts clean; a session older than 24h starts clean; a
   detail tick is visible when entering cooking from that detail sheet;
   a recipe whose lines are ALL precise renders checkable rows (the
   recipe-5995 reproduction — an imprecise-line-only fixture is not
   sufficient coverage).

## Consequences

- ADR-0081's decision 2 ephemeral clause is superseded IN PART (its
  presentation ruling stands untouched): the per-STEP wipe is retired in
  favor of a session-scoped set that lives up to 24h on the device. The
  record's Status line is flipped to record that.
  `docs/agents/cooking.md`'s checklist bullet is reworded in the SAME
  change — it currently teaches the per-step ephemeral rule.
- ADR-0073's "the checklist is ephemeral" clause is superseded IN PART
  on detail only: the prep card keeps its ephemerality (decision 2) but
  renders from the sheet's shared used set (decision 3b) instead of its
  own state.
- The cooking e2e suite re-pins: session persistence (step navigation +
  reload within 24h), mark-cooked clear, 24h expiry; the detail step
  specs gain the checkable rows and the ingredient-card linkage.
- The ui store's persisted slice gains ONE keyed entry (recipe id →
  {startedAt, usedKeys}) — no room payload, no backup slice beyond the
  existing ui backup, no relay change, no migration, no new runtime
  dependency.

## Alternatives considered

- **Room-synced used state** (a new synchronized store): rejected — a
  household does not share "I added the salt" mid-cook; the payload cost
  and the add-store surface (relay core + per-store migrations on both
  runtimes) buy nothing. If the owner later wants household visibility,
  that is a new record, not an amendment here.
- **Never persists across visits**: superseded by the owner's final
  ruling (2026-11-26): cooking mode DOES remember — for the session's
  lifetime, capped at 24 hours, device-local (decision 1) — while the
  detail sheet stays fully ephemeral (decision 2). The record's history:
  a persisted per-recipe set was drafted, withdrawn to pure session
  state, then re-introduced with the 24h TTL and mark-cooked clear after
  the owner's soak of the PR preview.
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
- **KISS** — one keyed slice entry with a TTL stamp over any alternative:
  the honest-resume rule reuses the ADR-0020 `startedAt` reasoning, the
  expiry is a read-time check (no sweeper), and the detail sheet keeps
  plain component state (ADR-0073's reasoning) — no scheduler, no
  background worker, no room payload.
- **SOLID** — the clear lives on the one `recordCook()` path (ADR-0083's
  convergence ruling), so the session-finish rule has exactly one
  owner; the TTL check has one owner (the shared accessor).
