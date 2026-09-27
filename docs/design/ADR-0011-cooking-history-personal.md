# ADR-0011: Cooking history is personal state surfaced in two ways

Date: 2026-09-28 · Status: Accepted

## Context

Phase 7 added a personal `cookedHistory` to the plan store
(`mealime-planner:v1:plan`, `pick`-ed for persistence) as a side effect of
`markCooked`. It had no read-side surface. Room sync deliberately shares
only `{plan, customItems, checked, cleared}` (ADR-0006); `cookedHistory`
must stay out of the room payload — what I cooked on my device is mine.

## Decision

1. **Boundary reaffirmed**: the room payload stays
   `{plan, customItems, checked, cleared}`; `cookedHistory` remains
   personal and out of sync. The History view states this in a subtitle.
2. **Per-event rows**: `markCooked` appends one row per cook event
   (`{variantId, cookedAt}`, newest first, capped at 200) instead of
   replacing the variant's previous row. This is what lets the UI
   aggregate a per-recipe cook count; pre-existing persisted data (one
   row per variant) reads as `count = 1` with no migration.
3. **Read side lives in `src/lib/history.ts`**: `aggregateHistory`
   (per-variant `{count, lastAt}`, sorted most-recent-first),
   `cookCount`, `lastCooked`, plus relative (`Intl.RelativeTimeFormat`)
   and absolute formatters. Views never aggregate themselves.
4. **Two surfaces**:
   - Recipe detail: "Cooked 3 times · last 2 days ago" line
     (`data-test="cook-history"`), hidden when never cooked; absolute
     date on tap/hover (`title`).
   - `/history` as a 4th bottom tab (Recipes / Plan / Grocery / History
     — short labels fit the Pixel 7 bar): aggregated rows
     (`data-test="history-row"`) with cook-count badge, last-cooked
     relative date (absolute on tap/hover), deep link to the detail
     view, an empty state (`data-test="history-empty"`), and an
     "Add to plan" action reusing the store's `addToPlan` flow.
5. Nutrition display stays per-serving (ADR-0002); history rows do not
   scale or rescale nutrition.

## Consequences

- The 4th tab is purely additive; active-tab highlighting is path-based
  and unchanged.
- Because rows are per event, the 200-entry cap now applies across all
  variants — a heavy cook loop can evict old single-event recipes. The
  cap stays for localStorage size; eviction is oldest-first, which is
  the desired recency bias.
