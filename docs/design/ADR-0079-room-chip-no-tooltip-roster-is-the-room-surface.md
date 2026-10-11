# ADR-0079: The room chip drops its tooltip; the roster sheet is the room's info surface

- **Status:** Accepted
- **Date:** 2026-10-11
- **Supersedes:** the chip-tooltip requirement of ADR-0049 (native `title` →
  bubble) for the room chip; ADR-0055 itself (ONE tooltip component) is
  untouched — `TooltipBubble` remains the tooltip implementation everywhere
  else (version button, grocery provenance pill).
- **Note on numbering:** ADR-0078 (the home hero) is reserved by open PR #71
  and is not yet on `main`; this record takes the next free number to avoid
  colliding with it at merge time.

## Context

The header room chip (dot | badge | word, ADR-0049) carries a
`TooltipBubble` repeating its `aria-label` sentence ("Live room
`code`, N in room") — a hover-only, pointer-only affordance that
duplicates what the chip already announces. Tapping the chip opens the
roster sheet (ADR-0063), which lists the PEOPLE in the room and nothing
else about the room itself.

Owner ruling (2026-10-11): the tooltip can go; the sheet, not the chip,
is where room information belongs — and the sheet should name the room
and carry the share action.

## Decision

1. **The chip loses its tooltip.** The `TooltipBubble` comes off the
   room chip; the `aria-label` (already the screen-reader carrier and
   the e2e handle) stays exactly as it is. Hovering the chip no longer
   reveals a bubble; tapping it still opens the roster.
2. **The roster sheet NAMES the room.** The sheet header gains the room
   code — the room's name — rendered in JetBrains Mono (the data
   voice, DESIGN.md), selectable.
3. **The sheet carries the share action.** A "Share room link" button
   in the sheet copies `<origin>/plan?room=<code>` through
   `useShareRoomLink()` (ADR-0023) — verified write, never a silent
   failure, never a raw clipboard call. The sheet is now the one place
   a household member can answer "what is this room called and how do
   I bring someone in" without leaving the header.

## Trade-offs (DRY > SOLID > KISS)

- **DRY win:** the share action keeps ONE funnel — `useShareRoomLink()`
  (ADR-0023) already resolves the code and owns the verified-write
  behaviour; the sheet passes the code it DISPLAYS so share and display
  cannot disagree, but the link-building/copy/toast knowledge is not
  copied. Likewise the room code renders through the `font-mono-data`
  utility — the data-voice knowledge lives in DESIGN.md/style.css once.
- **SOLID win:** the tooltip's hover-reveal was pointer-gated and
  duplicated the `aria-label`'s sentence in a second string that could
  drift; the sheet states room facts once, input-agnostically.
- **KISS win:** deletion over machinery — the bubble, its
  `below-right` overflow lessons for this host, and the chip's
  `cursor-help` all had their job vanish; no component was extracted
  for the code chip (one call site on this branch; unify with
  JoinCongratsModal's display chip only if their futures converge).

## Consequences

- The chip is a pure status + door affordance: dot, badge, word, tap.
  Its information surface is the sheet, which works identically with
  touch, keyboard and pointer — the hover tooltip was the only
  pointer-gated piece of the room UI, so the room UI is now
  input-agnostic.
- `data-test="room-chip-tooltip"` is gone; no spec asserted it. New
  hooks: `roster-code` (the room name) and `roster-share` (the share
  button).
- ADR-0049's "the bubble replaces the native title" ruling stands for
  every OTHER tooltip host; this record only retires the chip's host.
- The share action joins the auto-join toast's `shareAction` and the
  Plan tab's Share sheet as the third ADR-0023 surface — same
  composable, so the verified-write behaviour cannot drift.
