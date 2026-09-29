# ADR-0032: Cooked history is shared by default, with a permanent opt-out

**Status:** Accepted (2026-09-29)
**Supersedes:** the DEFAULT of [ADR-0011](ADR-0011-cooking-history-personal.md)
(history was personal-by-default behind an opt-in). ADR-0011's *shape* — one
append-only `cookedHistory` list, aggregated per recipe by `src/lib/history.ts`,
excluded from grocery aggregation — is unchanged and still in force. Also
refines [ADR-0028](ADR-0028-filter-sync-and-join-reconciliation.md) §5.

## Context

The owner ruled that a household wants **one shared cooking log**: "basically
everything should be sync". ADR-0011 had made history personal by default,
gated behind a `shareCookedHistory` opt-in that is `false`, and the first pass
of PR #8 deliberately left that default alone and made the opt-in more
discoverable instead.

The owner has now reversed that policy, so the default moves to **on**, and the
setting becomes an **opt-out**. Two things follow that a bare `ref(true)` does
not solve.

### 1. The persisted value cannot be trusted across the upgrade

`shareCookedHistory` is persisted per device. On an install that has been
running the pre-ADR-0032 build, the stored `false` is **indistinguishable from
"the user never touched it"** — the persistence plugin wrote the old default
out on the first save, long before anyone saw the setting. Reading that value
as a decision would leave *every existing install permanently opted out*,
which is precisely the outcome the owner ruled against.

### 2. Whole-state replace would now destroy history

Room sync is whole-state last-write-wins. While history was opt-in, at most one
device normally had it switched on, and the apply path replaced the local list
wholesale — an intentional wipe-to-empty, because a sharer with an empty
history was telling peers something true about itself. Now that **every**
device pushes its own history at once (the moment the default flips, each
device's own edit triggers a retroactive push), that replace becomes a race
where the last writer erases the other phones' cooks. History is append-only
and there is no delete feature, so a shorter peer list is not a statement that
our rows should disappear.

## Decision

1. **`shareCookedHistory` defaults to `true`.** The room payload includes
   `cookedHistory` unless the *sender* has opted out.
2. **A one-time, explicit migration marker.** The `ui` slice persists
   `historyShareDefaultMigrated`. On hydration:
   - flag absent (pre-ADR-0032 blob) → the stored boolean is treated as
     **unset**, the new default is adopted, and the flag is written;
   - flag present → nothing is touched, so **any toggle the user makes from
     now on is permanent** and no future default change can override it.
   `applySettings` (backup import) also sets the flag, because a restore that
   carries the value is an explicit choice.
3. **History merges on apply, it does not replace.** `plan.mergeCookedHistory`
   unions the inbound list with the local one, deduplicated on
   `(variantId, cookedAt)`, newest first, same 200-row cap. Backup import
   keeps `replaceCookedHistory` — a restore is an explicit full overwrite, and
   the confirm dialog says so.
4. **The debounce guard does not apply to append-only members.** ADR-0028
   rule 2 withholds a snapshot's last-write-wins content while a local edit is
   queued for push. That is correct for the plan, checks and filters, and
   wrong for cooked history: the peer's cook events would be dropped, our push
   would be built from the local list, and **nothing would ever resend them** —
   the loss is permanent, not merely a race. An inbound `cookedHistory` is
   therefore merged even inside the guard window; a union cannot clobber the
   queued edit, so the rule's intent (our edit wins) is untouched.
5. **The opt-out stays first-class and obvious.** Settings → Household sync
   carries the toggle (on by default, "turn this off to keep this device's
   history strictly private; the choice sticks"), the Plan tab's room sheet
   keeps its checkbox, and the History tab states that the log is shared and
   how to make it private.

### The trade-off, stated plainly

The migration **re-enables, once, any device that had deliberately opted
out**. There is no mechanism that can do better: the old build recorded a
bare boolean and no timestamp, so "opted out on purpose" and "never opened the
setting" are the same bytes on disk. The alternatives were:

- *Trust the stored `false`* — respects a deliberate opt-out but leaves every
  existing install opted out forever, i.e. the owner's ruling would only
  affect new installs. Rejected.
- *Prompt on first launch* — a one-time modal asking "you had history sharing
  off; keep it off or turn it on?". Honest, but a migration nag for a
  setting most households will never think about, and it cannot run offline
  in a sensible place either. Rejected in favour of the default plus a
  one-tap reversal.

The reversal is one tap in Settings, and the marker means it happens exactly
once. This is called out in the PR body and the report so the owner can decide
whether a nag is worth it for their own install.

## Consequences

- A household that joins a room converges on one merged cooking log.
- A device that opts out never puts its history on the wire, and receives the
  room's history like any other member — which is the honest reading of
  "opt out of sharing", and is now what the copy says.
- Counts in the History tab are household counts on a shared install and
  device-local counts on an opted-out one.
- `docs/design/ADR-0011-cooking-history-personal.md` is **not edited in
  place**; it carries a superseded-by pointer at the top. ADR-0028 §5 gains a
  pointer here.

## Alternatives considered

- **Keep the opt-in, just improve the copy.** Rejected by the owner's ruling.
- **Merge-only, no migration marker, default read straight from the stored
  value.** Rejected: it silently preserves the old default on exactly the
  installs the change is meant to reach.
- **Union the plan itself.** Rejected: the plan is a *set* with a meaningful
  order, and merging it is a different problem from an append-only log.
