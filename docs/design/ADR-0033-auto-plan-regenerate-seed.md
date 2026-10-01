# ADR-0033: An Auto-Plan "Regenerate" press rolls the seed

**Status:** Accepted (2026-10-01)
**Refines:** [ADR-0027](ADR-0027-auto-plan-v2.md) §4 (the seed rotation
contract) and [ADR-0027-auto-plan-v2](ADR-0027-auto-plan-v2.md)'s
"rotate the seed" rule, which until now only fired on *apply*.

## Context

ADR-0027 made the Auto-Plan pack a function of a persisted counter,
`ui.autoPlanGeneration`, so the app does not hand a household the same four
recipes forever: the planner picks its seed as
`byRating[generation % ROTATION_K]` (`src/lib/packPlanner.ts`, `ROTATION_K`
= 5), which fully determines the FIRST element of the pack and steers the
greedy fill from there. The counter was advanced at exactly one place — a
successful `confirmAutoPlan()` apply — with the reasoning "the pack you just
confirmed must not repeat, so the next Generate starts somewhere else".

That reasoning is right, but the *implementation* leaves the most obvious
interaction in the product dead. The Plan-tab dialog has one button whose
label is chosen at render time (`autoPlanBusy ? 'Generating…' : pendingPlan
? 'Regenerate' : 'Generate'`), and BOTH labels go through the same
`generateAutoPlan()` handler. The sequence a user actually performs is:

1. open the dialog, press **Generate** → preview pack P at generation N;
2. press **Regenerate** (the label now promises "give me another") → the
   handler re-reads the same counter, and `packPlanner` being pure and
   deterministic, the planner rebuilds **byte-identical pack P**.

So the affordance that exists precisely to escape a pack the user does not
like is the one affordance that cannot escape it. Meanwhile the load-bearing
`PINNED_DEFAULT_IDS` e2e pins (the v2 default 4-pack
`[17452, 6389, 9889, 6167]`, generation 0) argue the opposite way for the
FIRST press: a fresh install that regenerates on open must keep landing on
the documented default pack, or every catalog/scoring pin in the suite goes
red for a cosmetic change. The two requirements are only separable if the
advance is conditional on there already being a pack to differ from.

## Decision

1. **The seed generation advances at TWO points**, both in the Plan tab:
   - **on every successful apply** (`confirmAutoPlan`, the ADR-0027 rule,
     unchanged), and
   - **synchronously at the START of a press, iff `pendingPlan` is already
     set** — i.e. only when the button reads **Regenerate**. `generateAutoPlan`
     does `if (pendingPlan.value) ui.advanceAutoPlanGeneration()` before it
     captures anything or awaits the planner.
2. **A first press ("Generate") never advances.** No earlier pack exists to
   differ from, so the stored generation is honoured as-is. A fresh install
   stays at generation 0, and the pinned default pack stays default.
3. **The advance is synchronous, the apply's advance stays a bump.** The
   regeneration bump happens before the `await`, so the `wanted.generation`
   the run captures is already the fresh one and the post-await staleness
   re-check (`generation !== ui.nextAutoPlanGeneration()`) still drops
   superseded results. `confirmAutoPlan` therefore never re-reads the counter
   — it only bumps it — so a pack previewed at generation N lands exactly as
   shown and leaves the counter at N+1.
4. **A regeneration in flight makes the on-screen preview unconfirmable.**
   The press supersedes the pack currently on screen, so applying THAT pack
   would advance the counter twice (once for the press, once for the apply)
   and land a pack stale by two generations. `previewComplete` therefore also
   requires `!autoPlanBusy` (the confirm button is disabled and says
   "Waiting for the new plan…"), with a belt-and-braces guard in the handler
   itself. The old preview becomes confirmable again on its own after a
   FAILED rebuild, because the busy flag clears in the `finally` — the
   rejection of the old pack is not permanent.
5. **A filter change re-arms the first-press rule.** The existing watcher on
   `[count, category, mode, ruleset]` clears `pendingPlan`, so the next press
   reads "Generate" and honours the stored generation again.
6. **The lib stays pure.** Nothing about "is this a regenerate" reaches
   `src/lib/packPlanner.ts`; the decision is entirely the caller's.

## Consequences

- **Regenerate is now a real roll.** Two consecutive presses inside one dialog
  session differ, and N presses return to the same pack after `ROTATION_K`
  (5) of them, which is the rotation the label implies.
- **Undo is unaffected.** `confirmAutoPlan`'s undo restores only the plan
  entries and the cleared map; the counter is not part of the snapshot, so
  undo does not rewind the seed (rewinding would make "undo, then Regenerate"
  replay the pack the user just discarded).
- **A failed or raced rebuild costs one seed value, not integrity.** The seed
  is `generation mod 5`, so a gap shifts which pack comes *next*; a pack that
  did resolve is still internally consistent and still deterministic at its
  own generation. (The post-await staleness guard also means a stale result is
  dropped, not shown.)
- **The e2e contract changed, deliberately.** The determinism pin still holds
  at a FIXED generation (it sets the counter directly and asserts two
  regenerations agree). The rotation spec no longer presses a single
  generation repeatedly and expects variety — that expectation was only ever
  satisfiable because the spec itself bumped the counter between presses. It
  now pins the real contract: first press at generation 0 reproduces
  `PINNED_DEFAULT_IDS[0]` as the head and leaves the counter at 0, each
  further Regenerate press advances it by exactly one and changes the pack,
  and the apply advances it one more time. Both projects (Desktop Chrome and
  Pixel 7) run these.

## Testing notes

The **mid-roll confirm block is enforced in code, not pinned in e2e**. A
Regenerate press takes the *memoized* index and catalog paths, so the busy
window is a microtask-to-sub-frame interval — far shorter than Playwright's
first poll, and `page.route` cannot widen it because both loaders memoize
after the first run. An e2e assertion on the disabled state would be a
timing coin-flip, so the invariant is pinned by construction (the gate and
the handler guard) and by the ADR text. The *observable* half — that a press
rolls the seed and an apply advances once more — is e2e-pinned, and the test
helper waits on the dialog's busy state rather than on tile visibility,
because the previous pack's tiles stay mounted for the whole await.

## Alternatives considered

- **Advance on every press, including the first.** Rejected: it breaks the
  documented generation-0 default pack and every pin that depends on it, to
  buy nothing — the first press has no previous pack to escape.
- **Advance inside the planner / after the await.** Rejected: the run would
  build from the old generation and only the NEXT one would differ, so the
  first Regenerate after a Generate would still be a no-op — the exact bug.
  Advancing after the await also races the staleness guard.
- **Make Regenerate shuffle a separate unpersisted offset.** Rejected: two
  sources of rotation is worse than one; ADR-0027 deliberately persisted the
  counter (survives a reload, travels in backups, travels to a peer via
  `applySettings`).
- **Re-roll only when the rebuilt pack equals the previous one.** Rejected:
  it makes the seed depend on planner output, reintroduces the coupling
  between the dialog and the pure lib, and behaves worse (a legitimate
  duplicate would be silently re-rolled, hiding determinism).
