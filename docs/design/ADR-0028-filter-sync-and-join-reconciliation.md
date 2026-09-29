# ADR-0028: The quick filters are household state, and adoption is the join

**Status:** Accepted (2026-09-29)
**Extends:** ADR-0006 (rooms), ADR-0004 (share), ADR-0011 addendum
(cooked history is personal), ADR-0019 (household room), ADR-0026 (join
or create), ADR-0027 (unified filters). Adds one OPTIONAL member to the
room payload and states the reconciliation contract for `join`.

## Context

The owner: *"same for History sync in the room, basically everything
should be sync."* Two things followed from ADR-0027: the filter
selection was the one piece of app state that was neither persisted
nor shared, and the room already carries plan, custom items, checks,
cleared ingredients and custom-ingredient memory.

Proving the sync end to end surfaced three reconciliation defects that
predate the filters — they are the reason this ADR exists.

## Decision

### 1. `filters` is household state, carried optionally

`SharedState` gains `filters?: SharedQuickFilters`. It is a snapshot member
like `plan`, pushed by every sender.

**It is the SHARED half only.** `favOnly` is deliberately excluded
(`toSharedFilters`): the favourites set itself is personal and never
crosses the wire, so sharing the "favourites only" switch would impose
one device's taste on a device with a different — or empty — set and
render its Recipes tab blank. On receive, `mergeSharedFilters` re-applies
the local `favOnly`, so the switch persists but never travels.

**Optional means "don't touch".** A peer running older code sends no
`filters` key, and a payload WITHOUT it must leave the local selection
alone. Treating absence as "empty" would wipe the household's filters on
every push from an un-upgraded phone — the additive-payload rule from
ADR-0004/0012, applied to a new member. Incoming values go through
`normalizeQuickFilters` first, so a hand-crafted or truncated payload
can never put a raw value in the UI.

### 2. A queued local edit outranks a snapshot that arrives before its push

The push path is debounced 300ms. Before this ADR, tapping a filter and
then receiving a peer snapshot inside that window lost the tap: the
snapshot was adopted, and the push that fired afterwards was built from
the now-remote state and re-broadcast the peer's value at a higher rev.
The household converged on the WRONG answer, permanently, with no client
able to tell.

A local edit that is queued for push is now withheld-proof: an inbound
snapshot's **revision is still absorbed** (it is proof of ordering, and
dropping it would make our next push reuse a rev the room has already
passed) but its **last-write-wins content is not applied**. Our push then
goes out at `maxSeenRev + 1` with our whole state and wins on its own
merits. **Append-only members are the exception** — an inbound
`cookedHistory` is merged even inside the guard window, because refusing it
would lose those cook events permanently (see ADR-0032 rule 4).

### 3. Adoption ends a join; a joiner does not echo

Previously every `joined` ended with a "converge" push. After adopting
the room's snapshot, that push re-published the snapshot at a HIGHER
rev. A snapshot can be stale by exactly the in-flight window — a peer
whose edit has not reached the relay yet — so the echo could win the rev
race and freeze the household on old state, with the peer's correct push
now permanently older.

Adopting a snapshot leaves local state byte-identical to the room's, so
the echo was never needed to converge; it was only a way to lose a
peer's newer edit. A join that adopted does not push. A join that did
**not** adopt (empty room, or a snapshot the ADR-0026 rev floor
rejected) still pushes, which is the F4 guarantee unchanged.

### 4. An edit that could not be sent outranks the join response

An edit made while the socket is not live — the ~1s a room takes to come
up, which is exactly when a user taps a chip after launch — was silently
dropped: `schedulePush` returned early, the join then adopted the room's
older snapshot over the edit, and nothing ever republished it. Such an
edit is now remembered and makes the join skip adoption and push
instead: we are the only party that can prove our state is newer.

The flag is deliberately narrow, because a broad one is its own bug: it
is set ONLY while a join or reconnect is in flight for a room we are
actually in (`code !== null`, status `connecting`, or a socket that died
inside the debounce), never for an edit made with no room at all, and
`leave()`, `create()` and a join into a *different* code clear it. A
sticky flag would make a join much later skip the household's snapshot
and push a stale local plan over everyone.

Together, 2–4 give the reconciliation contract:

> On join, a device with no undelivered edits **adopts the room's state
> (the household wins)** and stays silent. A device holding undelivered
> edits **publishes them** and does not adopt. Either way, after the
> dust settles every device holds the same state, and the newest fact
> anyone can prove wins.

### 5. Cooked history is shared by default (moved to ADR-0032)

At the time this ADR was written, `cookedHistory` was excluded from the
payload unless the sender opted in, and flipping that default was held back as
a policy question for the owner. **The owner has since ruled the other way:
history is shared by default** — see
[ADR-0032](ADR-0032-cooked-history-shared-by-default.md), which supersedes
ADR-0011's default, adds the one-time migration marker, and makes the
room-apply path a MERGE rather than a whole-state replace (with every device
pushing at once, a replace would let the last writer erase the other phones'
cooks). The setting survives as a permanent opt-out, surfaced in the Settings
household card and the Plan tab's room sheet.

## Consequences

- The household shares: plan, servings, custom items, grocery checks,
  cleared ingredients, custom-ingredient memory, quick filters, and —
  only for opted-in senders — cooked history.
- Still personal: favourites (a private taste signal) — **including the
  `favOnly` filter switch that rides with them**, step timers (they
  belong to the cook in progress), the search box (ADR-0027), the theme
  override (per-device display) and the room code itself.
- Whole-state LWW means a device that has been offline long enough to
  be adopted loses its offline edits by design. Rule 4 narrows that
  window to "edits this session could not deliver", which is the most
  the wire can prove.

## Alternatives considered

- **Flip the history default to shared.** Rejected for now: it
  contradicts an accepted ADR and the owner's intent is not
  unambiguous enough to amend ADR-0011 unilaterally. Raised for the
  owner in the PR body instead.
- **Sync per-field (merge on apply).** Rejected: whole-state LWW is what
  ADR-0006/0026 built and what every other member relies on; a
  field-level merge is a different protocol and a different ADR.
- **Relay-side ordering (a settle window before a join may push).**
  Rejected: it would put a sleep in the client for something the client
  can decide correctly from the rev it was handed.
