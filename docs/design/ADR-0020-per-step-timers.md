# ADR-0020: Per-step timers in the cooking view

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0010 (Meanwhile step views), ADR-0013 (`STORE_SLICES`
registry). Nothing about the recipe documents, the step text or the
grocery derivation changes.

## Context

Cooking mode walks a recipe step by step, but a recipe's instructions
routinely say things the step text cannot express in numbers: "simmer
20 minutes", "bake 35 minutes", "rest 10 minutes". The app had no way
to run a countdown for that, so the phone — which the wake lock keeps
alive precisely so you can read hands-free — was only used to read.

## Decision

1. **One timer per step VIEW, not per raw step.** A view is the leader
   step plus its optional "Meanwhile" partner (ADR-0010), because those
   two run *at the same time*: two timers on one screen would be a lie
   about concurrency, and a single timer on the pair is the honest
   model. The timer is keyed by the view leader's raw step index, so it
   follows the view as you navigate.

2. **Timers are client-side only — no server round-trip.** The relay
   carries household state (plan, groceries, customs); a stopwatch is
   personal and per-device, exactly like `cookedHistory` (ADR-0011).

3. **State rides the ui slice, so a reload resumes honestly.** The
   timer is stored as `{ remaining, running, startedAt }` and lives in
   `ui.stepTimers[variantId][viewKey]` (`src/lib/stepTimer.ts` for the
   pure maths). The countdown is always derived from
   `remaining - (now - startedAt)`, never from a re-armed counter: close
   the app mid-`3:00`, come back two minutes later, and it says `1:00`
   rather than restarting. Because it is a persisted store slice, it is
   registered in `STORE_SLICES` (`settings.json`) in the same change, per
   the ADR-0013 standing rule.

4. **Wake lock unchanged.** The best-effort `navigator.wakeLock` that
   cooking mode has always requested already covers "the timer is
   running"; the timer adds no second mechanism and no re-request storm.

5. **The countdown never touches the toast surface.** The toast area
   belongs to user-initiated events (added, cleared, joined). The
   countdown is announced through a polite live region that changes ONLY
   on minute boundaries (`announceCountdown`) — per-second updates there
   would flood a screen reader. The visible `mm:ss` is `aria-hidden` and
   the accessible name carries the same value.

6. **The recipe's own `cooking_minutes` is a SUGGESTION, on the first
   view only, explicitly labelled** ("⋯ 35m total"). It is the total
   recipe time, not this step's, so it must never be presented as the
   step's; offering it repeatedly on every step would invite exactly that
   mistake.

7. **Leaving the cook session with a running timer asks first.** Both
   `Finish` and `Mark as cooked` confirm while a timer is running
   (declining keeps the session *and* the timer). Silently killing a
   countdown the user is watching would be the worst possible default;
   the wake lock keeps the screen alive, so nothing forces the decision.

## Alternatives considered

- **One timer per raw step.** Rejected: a Meanwhile pair is concurrent by
  definition; two independent countdowns for work happening at once is
  misleading, and it doubles the state for no extra information.
- **Server-side / room-shared timers.** Rejected: cooking is personal
  (ADR-0011), the relay is intentionally stateless, and a shared stopwatch
  invites write conflicts over something that must be identical to both
  cooks anyway.
- **Toast or notification per elapsed stage.** Rejected: toasts are for
  user-initiated events and expire; a countdown needs a persistent,
  glanceable surface.
- **Deriving a per-step duration from the step text.** Rejected: the step
  text is authored prose ("simmer until reduced") and guessing a number
  out of it would invent quantities — the same rule the measured-amount
  chips under step text follow (ADR-0022).

## Consequences

- A cook can arm a timer from any step, and a running one keeps running
  while they page back and forth, so a long bake is not lost to
  navigation.
- `ui.stepTimers` grows the persisted ui payload slightly; it is bounded
  by recipe variants actually cooked (6 h cap per timer, entries pruned
  when cleared).
- Reload-with-timer is honest rather than surprising; the backup file
  carries timers too, which is harmless (they expire by themselves).
- Timer state is device-local and therefore never pushed to a room.
