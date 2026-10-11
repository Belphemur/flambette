# ADR-0081: Cooking mode adopts the card composition and honest timer suggestions

**Status:** Accepted (2026-10-11).
**Extends:** ADR-0020 (per-step timers — state semantics unchanged), ADR-0041
(the timer suggestions + global strip — the suggestion SOURCE is unchanged,
its per-step SURFACE moves into a card), ADR-0022 (measured amounts under
step text — the derivation is unchanged, the chip presentation becomes a
checklist), ADR-0072 (success family for completion — reaffirmed and made
visible on the cooking surface), ADR-0073 (cooking keeps the command room /
672px measure — unchanged).
**Supersedes (in part):** ADR-0022's chip presentation and ADR-0041's
per-step add-timer strip layout on the step surface.

## Context

Owner screenshot (Pixel 7, cooking mode) and report, 2026-10-11: "The timer
still doesn't look right, the checkbox can't be clicked, I want to see what
Stitch can give us for the cooking mode experience to be better and the
timer setting auto detection could be better too." Measured from the
screenshot:

1. The bottom timer strip crams name input (truncated at "Ric…"), preset
   chips (clipped at "5m") and the Start button (half-cut against the close
   affordance) into one row.
2. The step's ingredient chips ("3 tbsp olive oil", "1½ tsp salt") do not
   read as tappable — they render as static measured-amount text with no
   checkbox affordance (ADR-0022's chips are DISPLAY-only by design).
3. The preset row shows generic durations on a step with NO cook time,
   reading as if the app had "detected" them — the auto-detection is
   invisible when it fires and indistinguishable from noise when it
   doesn't.

Two Stitch renders were generated on the Warm Culinary Paper system and the
owner approved them verbatim ("Those again look perfect. Especially also
using green for mark a cooked"):

- Project `2725470430841257407` ("Flambette Recipe App")
- Mobile: screen `fc73bab0a78344f3b27243c0fbe57c20` — "Flambette — Cooking
  Mode (Mobile Step View)"
- Desktop: screen `0104c9f526a642ac8c45d665f4cc5e7f` — "Flambette — Cooking
  Mode (Desktop)"
- Design system `assets/146f70cf87be42a4aa2353420a3b07cd` (no new tokens).

## Decision (owner-binding)

1. **Composition.** Top to bottom: slim header (recipe title one-line
   truncate, mono progress line `serves N · Step i / n`, thin tomato
   progress bar, close), the STEP TEXT as the dominant element (20px/30px
   mobile, 22px/34px desktop — the largest body copy in the app on this
   surface), then the two cards, then the action deck. The 672px
   `max-w-reading` measure is UNCHANGED (ADR-0073: a step read at arm's
   length wants a measure, not a page); desktop richness is the
   `lg:`-gated two-column card row INSIDE the measure, never a wider
   layout.
2. **"This step uses" checklist card.** The ADR-0022 measured-amount chips
   become a card of interactive checklist rows: full-row ~56px tap targets,
   20px rounded checkboxes (warm `#D3C4B0` border), amount in bold mono,
   ingredient name beside it; checked = success green fill + struck-through
   muted text (ADR-0072: completion is the success family, NEVER a food
   hue, on a checkbox). The DERIVATION is untouched — same
   `measuredAmounts.ts` source, same nameKey matching, same no-invented-
   quantity rule, same scaling import; this is a PRESENTATION supersession
   of the chips. Checked state is per-step ephemeral view state (the chips
   were never persisted; nothing changes there).
3. **"Timers for this step" timer card.** Every control gets its own row or
   chip — the one-thing-per-row rule that kills the cramped strip:
   (a) the SUGGESTION row (decision 4), (b) quick-start preset pills
   (44px+ height, mono digits), (c) a FULL-WIDTH name field on its own row
   (never truncated again), (d) a minutes input + filled-tomato
   "Start timer" button on one row. ADR-0020's state semantics are
   untouched: one timer per step VIEW, `{remaining, running, startedAt}`
   in `ui.stepTimers`, countdown derived from `startedAt`, polite live
   region for minute ticks, never the toast surface,
   `MAX_TIMER_SECONDS` lockstep with the extractor.
4. **Honest auto-detection.** The ADR-0041 sidecar hints remain the only
   suggestion source. When a step HAS a detected duration, the card offers
   it as a suggestion ("Detected: 25 min — Roast" with a one-tap add).
   When it does NOT, the card SAYS SO ("No cook time mentioned in this
   step — set one if needed") instead of rendering presets as if they were
   detected. Presets are labelled quick-start affordances, never
   suggestions. No invented durations — the same anti-fiction rule as
   ADR-0022's quantity rule.
5. **Global strip keeps its role.** ADR-0041's global multi-timer strip
   remains the RUNNING-timers surface (visible across steps, multiple
   concurrent timers); what moves into the card is the per-step ADD
   affordance. The strip is untouched by this ADR.
6. **Action deck.** Bottom, safe-area padded: outlined "Previous" +
   filled-tomato "Next" (flex-1) on one row; a full-width tonal
   "Mark as cooked" with the success-green check glyph and green text
   below — TOMATO = begin (next), SUCCESS = complete (cooked), per
   ADR-0072, which the owner explicitly praised in the render.
7. **Token discipline.** The renders contain generator stray hexes (solid
   tints `#FEF9EE`, `#F4E4BA`, `#FBEAE5`, `#E3F2E5`/`#EDF7EE`/`#BCE3C5`,
   grays `#8E7B74`/`#9E8C85`/`#EAE2D5`/`#ECE4D6`, dark-saffron `#946200`,
   deep-red hover `#781A06`, muted brown `#875817`). Adoption maps them to
   the repo's tint pattern — `rgba(token, 0.08)` background over the token
   text, the DESIGN.md idiom — and the ADR-0072 colour semantics; NO new
   hex reaches `src/`. Rejected render fictions: the "Action Step" badge
   (generator invention — not in the repo), any difficulty/est-time
   metadata.

## Consequences

- The cooking view e2e suite re-pins: the strip's element positions, the
  chip assertions (data-test hooks move from chip to checklist row — keep
  the hook NAMES where semantics survive, e.g. the measured-amount rows
  keep a per-amount hook), and new pins for the honest-suggestion
  banner (a no-hint step shows the "no cook time" line; a hint step shows
  the detected suggestion).
- ADR-0022 and ADR-0041 records stay accepted; this ADR notes the
  presentation supersession on their surfaces — their derivation/source
  rules are cross-referenced, not weakened.
- No new persisted state; `ui.stepTimers` shape unchanged; the checklist
  checked state is ephemeral.
- The measured-chips → checklist change touches the SAME data-test space
  as ADR-0022's pins — the old chip hooks must be re-pinned loudly, which
  is the contract working.

## Alternatives considered

- **Status quo strip with more padding.** Rejected: the row is
  structurally cramped (three controls, one line, a 390px viewport) — no
  spacing fix makes a truncated name field acceptable.
- **Move the add-timer into a modal/sheet.** Rejected: an extra surface
  for a two-field action; the card keeps the timer visible WITH the step
  it belongs to.
- **Make presets disappear when no hint exists.** Rejected: quick-start
  timers are genuinely useful on prep steps ("set 5 min while the oven
  heats"); the fix is labelling, not removal.
- **Widen the desktop layout beyond 672px.** Rejected: ADR-0073's measure
  is the design decision; the two-column card row adds desktop richness
  INSIDE it.
