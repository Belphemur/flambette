# ADR-0010: "Meanwhile" steps render as one concurrent pair

- **Status:** accepted
- **Date:** 2026-09-28 (phase 11)
- **Decides:** how CookingView presents concurrent instruction steps

## Context

Some recipes contain instructions meant to run concurrently, flagged by
the word "Meanwhile" at the start of the step (1,846 of 2,730 recipes
have at least one). CookingView rendered one step at a time, which
serialized concurrent work by mistake — the cook finished step N before
seeing what they were supposed to do "meanwhile".

## Decision

- **Parsing** — `scaleSteps()` (in `src/lib/recipe.ts`, the shared
  step-scaling helper) marks a step `concurrent: true` when its
  `primary_message`, trimmed and lower-cased, starts with `meanwhile`.
- **View model** — CookingView groups raw steps into *views*: a
  non-concurrent step leads a view; an immediately following concurrent
  step becomes its partner (rendered in the same view, stacked under a
  "⏳ Meanwhile" divider). Both steps' ingredient detail lines scale to
  the same servings value (they already do — `scaleSteps` scales the
  whole doc with one factor).
- **Navigation** — prev/next move whole views: "next" from a pair
  advances the cursor by two raw steps, "previous" returns to the
  previous view. A persisted cursor that points at a partner index
  coerces to its pair, so no state migration is needed.
- **Progress** — the counter shows `Steps N–M / total` for a pair and
  `Step N / total` otherwise (raw step numbers, leader-based); the
  progress bar uses the last visible step.
- Deliberately minimal: consecutive Meanwhile steps (rare) attach to
  the previous pair-leader only if it has no partner yet, otherwise
  render alone. No general concurrency planner.

## Consequences

- Recipes without Meanwhile steps render exactly as before (the
  existing cooking e2e on "Tuscan Kale & White Bean Soup" is untouched).
- `data-test` hooks: `step-single` / `step-pair`, `step-text`,
  `step-partner-text`, `meanwhile-divider`, `step-counter`.
- Recipes may now be *finished* in fewer "next" presses than raw steps
  — finish detection is view-based (`isLast`), so no dead ends.

## Alternatives considered

- Showing the Meanwhile step as a persistent sidebar while other steps
  advance: better mirrors real cooking but is a visual redesign — out
  of scope for an algorithm-correctness phase.
- Pairing on the *following* step instead (render N and N+1 when N is
  concurrent): would orphan the lead step; the meanwhile text only
  makes sense next to the step it interrupts.
