# ADR-0051: rooms are the only way to share a plan — one-shot `?p=` links retired

- Extends: ADR-0004 (share URL deep-link + rooms), ADR-0006 (room model),
  ADR-0023 (one-tap share room link), ADR-0012/ADR-0050 (the extras checked
  key reconciliation)
- **Supersedes:** ADR-0004 §1 (the one-shot `?p=` URL share) in full
- Status: **Accepted** (2026-10-04)
- Companions: `src/App.vue` (`retireSharedPlanLink`), `src/components/PlanTab.vue`
  (room-only sheet), deleted `src/lib/share.ts` + `e2e/share.spec.ts`

## Context

ADR-0004 shipped two layers of plan sharing on purpose: a one-shot URL
(`?p=`, gzip+base64url of the whole plan) and live rooms (`?room=CODE`). The
owner's decision, verbatim: *"We should remove the basic share feature and
only keep the room one."*

Keeping both was defensible when rooms did not exist. Once rooms shipped,
the two-layer split became a cost with no remaining benefit:

- **Two ways to do one thing, and the weaker one is confusing.** A `?p=` link
  is a FROZEN SNAPSHOT. It replaces the recipient's plan wholesale, carries no
  checkbox state, no extras' categories beyond a flat name list, and nothing
  after it. A room link is live and bidirectional. Presenting both under one
  "Share" button meant the user chose between two options whose relationship
  ("snapshot vs live") the UI never explained.
- **The sheet had to hedge.** `planShareUrl` returned `null` when a plan
  exceeded `MAX_SHARE_LENGTH` (1800 chars) and the UI rendered "Plan too large
  for a one-time link — share it live instead." A limit at which one feature
  tells you to use the other is a sign the first feature should not exist.
  Note that the 1800-char ceiling was ALWAYS reachable: rooms were documented
  as "the overflow path" from day one, so the encoding size cap was really a
  de facto admission that one-shot links did not scale.
- **It was the weakest data path.** The `?p=` payload replaced `customItems`
  while carrying NO checked state, so any locally checked
  `custom||<name>` for an extra the link did not list became orphan residue —
  the residue ADR-0050's `reconcileCheckedExtras` existed to clean up, and one
  of its THREE ingress points existed only to serve this feature. Retiring
  `?p=` removes a source of desync, not just a source of sharing.

## Decision

1. **One-shot `?p=` sharing is removed outright.** `src/lib/share.ts` (the
   gzip/base64url encoder, the decoder, the v1 bare-array back-compat path and
   `MAX_SHARE_LENGTH`) is deleted. There is no "too large" fallback any more,
   because there is no size limit to fall back from — a room link is the same
   length regardless of plan size.
2. **Rooms are the only share path.** The Plan tab keeps its `Share` button
   and its sheet, but the sheet is **room-only**: the live-room block (room
   link, copy, the cooked-history toggle, peer count, leave) is unchanged. The
   button stays because that room UI is substantial and useful; only the
   link-URL half of the sheet is gone. Opening the sheet is now synchronous —
   it no longer encodes a plan, so it cannot fail.
3. **An old `?p=` link is retired LOUDLY, never silently.** `App.vue`'s
   `retireSharedPlanLink` still detects `?p=`, toasts *"One-time plan links
   were removed — share a live room link instead."* (8 s), and strips the
   param. This is the one deliberate piece of dead code kept, and it is not
   the decoder: a person who has such a link in a chat, a bookmark or a
   screenshot would otherwise open it and get a perfectly normal-looking app
   with no explanation for why their plan did not arrive. A one-line toast is
   a fair price for not stranding someone with a mystery. **The decoder
   itself is gone** — the payload is no longer honoured.
4. **`navigator.share` goes with it.** It was only ever wired to the `?p=`
   URL, so there is no longer a payload to hand the OS sheet. It also never
   worked on the plain-HTTP LAN origins this app is routinely used from
   (ADR-0023's own reasoning); the clipboard path remains, via
   `useClipboard({ legacy: true })`.

## Consequences

- One share mechanism, one button, no size ceiling, no fallback to explain.
- Extras' checked-key reconciliation drops from THREE ingress points to TWO
  (`room.applyRemote`, backup's `checked.json` writer). The docs, comments and
  `AGENTS.md` were corrected in the same change — leaving "three" in place
  would have been exactly the comment drift that made qodo flag a similar
  mismatch earlier.
- Anyone with an old `?p=` link keeps a working app and a clear explanation,
  but the plan in that link does NOT load. That is inherent to retiring a
  feature and is the owner's call, not a defect to be engineered around.
- `e2e/share.spec.ts` (3 tests: fresh-context restore, the
  `navigator.share` fallback, the oversized-plan fallback) is deleted with the
  feature. Test counts DROP by 3 — this is the deliberate removal of tests
  for removed behaviour, not coverage quietly lost.

## Alternatives considered

- **Keep the decoder behind a deprecation window** — rejected: it preserves
  the whole gzip/base64url surface (and the v1 back-compat branch) to serve a
  payload we have decided not to honour. The toast is the cheap version of the
  same courtesy.
- **Keep the share sheet, drop only the `?p=` half** — **chosen.** Deleting the
  button as well would have removed the room link, the history toggle and the
  leave control to get rid of a URL box that was already gone.
- **Auto-convert `?p=` recipients into a room** — rejected: it would invent
  household state (a relay room, a peer list) as a side effect of opening a
  link, which is a far larger commitment than the feature being retired.
