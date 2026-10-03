# ADR-0049 — Household join UX, the live peer count, and the relay protocol

* Extends: ADR-0019 (household room as a persisted default join target),
  ADR-0023 (share-room link), ADR-0026 (join-or-create lifecycle), ADR-0038
  (the Cloudflare relay adapter), ADR-0040 (the one TypeScript relay core),
  ADR-0044 (icon-scoped tooltips)
* Status: **Proposed** (2026-10-04)
* Companions: `server/relay-core/protocol.ts`, `server/relay-core/lifecycle.ts`,
  `server/relay.ts`, `server/worker/room.ts`, `src/stores/room.ts`,
  `src/App.vue`, `src/components/SettingsTab.vue`,
  `src/components/JoinCongratsModal.vue` (new)

## Context

The household room worked, and nobody could tell. Three findings, in the
owner's own words:

> "the code should be visible but only the join now button. That will save
> and join the room, then share link and last leave. That's it, make it
> simpler to work. The join now if no code will generate a new code
> automatically. Clicking new code will also join the room automatically."
>
> "Also we should add a proper tooltip to the live at the top and bring
> back some green dot for it."
>
> "Leave actually should remove the code too."
>
> "When using a shared room link the user should get a simple
> congratulations modal full page saying they have joined the household
> with the code."
>
> "Also in the settings (when connected only) and tooltip on the live
> chip we should show how many people are actively in the room now."
>
> "Be sure we have clear architectural docs on the protocol too."

Each of those is a symptom of one cause: **the app never told the truth
about the room it was in.** It knew `status` and `code` — a boolean and a
string — so the header chip could say "Live" and nothing more, the settings
card could only offer *Save* and *Join now* over the same field, and a
successful join was indistinguishable from a failed one except by a toast
that was replaced a second later.

The peer count is the interesting half, because it is the one thing the
**relay** already knew and threw away.

## The protocol, in one place

ADR-0040 put every relay *decision* in one TypeScript core with two thin
adapters. That split is what makes the count tractable, so it is worth
restating which side of the seam each concern lives on:

```
             server/relay-core/                    adapters
  protocol.ts   types + the error taxonomy    ──▶  both speak this shape
  lifecycle.ts  admit / push / keepalive /       relay.ts   (Bun: Maps,
               leave / expiry verdicts            worker/    Set<WebSocket>)
  policy.ts     TTLs, canonical codes            room.ts    (DO: SQL rows,
  codes.ts      normalizeRoomCode (re-exports    throttle.ts ctx.getWebSockets())
               src/lib/roomWords.ts)
  throttle.ts   attempt budget arithmetic
```

**The core owns decisions and never counts sockets.** It has no WebSocket,
no Map and no SQL — only a `RoomStore` interface with intents
(`read`/`write`/`drop`/`readFloor`/`writeFloor`/`dropFloor`). The two
adapters differ in exactly one thing: the peer set. A Bun relay holds a
`Set<Socket>`; a Durable Object can only ask the runtime
(`ctx.getWebSockets()`), which counts only *accepted* sockets and answers
*before* a freshly accepted one is visible. That difference is why the
membership **fan-out** must live in the adapters and the membership
**arithmetic** must not.

That is the whole architectural statement this ADR adds, and the peer count
is its first user.

## Decision 1 — the headcount is computed once, in the core

`admit(mode, livePeers)` already received the number of live peers: `create`
refuses a held code precisely by testing `livePeers > 0` (ADR-0026). So
"how many people are in this room once I have joined" is
`livePeers + 1`, and the core already has both operands.

```ts
export type Admission =
  | { kind: 'refuse'; error: RelayErrorCode }
  | { kind: 'establish'; code: string; rev: number; count: number }
  | { kind: 'join'; code: string; rev: number; state: SharedSnapshot | null; count: number }
```

Both adapters read `verdict.count` off the verdict. Neither recomputes it.
If the arithmetic lived in the adapters it would exist twice, and a
one-off difference between the Docker relay and the Cloudflare one would be
invisible until a household split its brain across the two deployments.

A refusal carries no count: a refused socket is not a member, so there is no
headcount to report.

## Decision 2 — one new frame, `peers`, on every membership change

```ts
| { type: 'peers'; count: number }
```

- **On admission** the relay fans a `peers` frame to *every* peer —
  including the joiner, whose `created`/`joined` already carried the same
  number. Redundant on purpose: the joiner is the one peer whose admission
  frame cannot arrive before the fan-out it triggers.
- **On departure** (`leave`, socket close, or being detached from another
  room) the relay fans it to the survivors.
- `created` and `joined` grow a `count` field so the first headcount a peer
  ever sees arrives with its admission, not a frame later.

Two adapter-specific consequences, both forced by the runtime rather than
chosen:

- **The DO broadcasts from `webSocketClose`, not from the `leave` case.**
  `ctx.getWebSockets()` reaps a socket *before* its close handler runs, so
  that handler is the first moment the post-departure headcount is a fact.
  Broadcasting `size - 1` from the `leave` case would be correct by
  arithmetic and wrong whenever the socket did not close cleanly.
- **A refused socket never counts.** `#refuse()` uses `server.accept()`
  rather than `ctx.acceptWebSocket` precisely so a refusal is not
  hibernated — which is also what keeps `code_taken` from inflating the
  headcount of the room it was aimed at.

The relay does not track *people*, it tracks *sockets*. One person on two
tabs is two; that is deliberate and is what "actively in the room" means.

## Decision 3 — the client stores a third state, not a number

```ts
const peers = ref<number | null>(null)
```

`null` is "not told yet" and is rendered differently from `1`: a device that
is still connecting is not a household of one. `leave()` restores `null`,
because the count described a room this device is no longer in. Anything
that is not a positive integer is **dropped**, not displayed — a relay
answering `0` for a room the asking socket is in is lying, and showing that
is worse than showing nothing.

The client never counts anything itself. It displays the last number the
relay gave it.

## Decision 4 — one primary action, `Join now`

The household card had two mutation buttons over one field (`Save` and
`Join now`) plus a third, `Adopt`, that existed only to point the setting
at a room the device was already in. Two buttons that do the same thing
differ only in *when* they take effect is a decision the user has to make
twice for no reason, and the `Adopt` button asked them to read a code off
a chip and type it back.

There is now exactly **one** mutation entry point for the code field:

| Input state | `Join now` does |
| --- | --- |
| empty | rolls a fresh code into the field, **creates** it |
| rolled here (never joined) | **creates** it |
| a parseable typed code | joins it (join-or-create, ADR-0026) |
| non-empty but unparseable | button is **disabled** |
| already live in this same code | no reconnect; just saves + confirms |

The rolled-code path **creates** rather than joins on purpose: it keeps the
existing `code_taken` re-roll behaviour (ADR-0026), so a collision re-rolls
instead of silently adopting a stranger's room. That is the exact review
finding (`qodo` 4128519644) the two-button design was working around.

`Save` and `Adopt` are **removed**. The input stays visible and editable,
including the KeepAlive draft-echo guard: a backup import landing
mid-edit must not stomp what the user is typing.

## Decision 5 — `Leave` is a full opt-out

`Leave` clears the saved code as well as the socket. Leaving the room but
keeping the code means the household **silently rejoins on next launch**,
which is the opposite of what a person who pressed "Leave" asked for. The
toast says so outright: *"Left the household room — it will not rejoin next
launch."* A stale saved code is not a convenience; it is a surprise.

## Decision 6 — one green dot, and a tooltip that is not the OS one

The header chip gets a `size-2 rounded-full bg-success` dot and a real
tooltip bubble (hover **and** `focus-within`, `pointer-events-none`,
`aria-hidden`) replacing the native `title`. The bubble carries the code and
the headcount; the chip's `aria-label` carries the same sentence, because
the label is what a screen reader — and the e2e suite — actually reads.

`success` is a **status** token, not a food hue (DESIGN.md: *"Status is not
food identity"*). It is a deliberately different green from `hue-vegetarian`
(`#137A38`) and `hue-vegan` (`#047857`) — at 8 RGB units from one of them a
green dot could have read as a dietary cue. `#116149` / `#34D399` measure
6.66:1 and 7.62:1 against `surface-sunken`, the chip they sit on.

The composable `useIconHoverTarget` is deliberately **not** used here: it
exists for `HueIcon`, whose host is pointer-transparent so a hover can never
match. The chip is a normal pointer-active element, and plain CSS
(`group` + `focus-within`) is the whole mechanism.

## Decision 7 — a join through a shared link is celebrated

A shared `?room=` link ended with a toast that was gone in three seconds,
which is indistinguishable from every other toast the app raises. Someone
who has just been handed a link by their household deserves to be told, in
one full page, that they are *in*, and to see the code they are in — because
the next thing they will do is show that code to someone else.

Gated on the `?room=` query **captured before `joinRoomFromLink` strips it**,
plus `status === 'live'` for that code. A link that fails shows the error
toast and no modal: the modal celebrates, it never excuses.

## Alternatives considered

- **Compute `count` in each adapter.** Rejected: it is one subtraction
  duplicated in two runtimes, with no local simplification to buy, and the
  whole point of ADR-0040 is that a relay semantic lives once.
- **Derive the count client-side from push traffic.** Rejected: a household
  that has been connected but idle for a day is still *in* the room, and a
  push-derived count would report zero.
- **Count peers, deduplicate by device.** Rejected: no device identity
  exists, and it would under-report the real thing the header is for.
- **Keep `Save` as a quiet sibling of `Join now`.** Rejected: the owner's
  instruction, and the review finding — two buttons whose only difference is
  *when* the sync starts is the kind of choice a kitchen surface should not
  ask anyone to make.
- **Reuse `Adopt` as the single action** (adopt the live room, or roll a new
  one). Rejected: it cannot express "I typed my household's code", which is
  the case a second phone actually has.
- **Celebrate with a toast instead of a modal.** Rejected by the owner
  directly; a toast is also what the successful join already had.
- **Reuse the green food hue for the live dot.** Rejected: DESIGN.md forbids
  status colours reading as food identity, and the two greens are close
  enough to collide.

## Implementation notes

- `success` / `success-soft` go in DESIGN.md **first**, then `@theme`, then
  the `.dark` flip; `src/lib/palette.test.ts` fails if the three drift.
- Test placement follows ADR-0040: the *decision* (the `livePeers + 1`
  arithmetic, a refusal carrying no count) is pinned in
  `relay-core/lifecycle.test.ts`; the *fan-out* is pinned at the wire level
  in `worker/room.test.ts` and through two browser contexts in e2e.
- **Timing trap in the worker suite:** the client-side `close` event takes
  ~10 s to surface through `Self` in `vitest-pool-workers`, while the DO's
  own close handler fires in ~10 ms. A departure test must await the
  surviving peer's `peers` frame, never `await peer.closed` — that exceeds
  the 5 s test timeout while the behaviour under test is already correct.

## Consequences

- The header chip and the settings status line answer "is anyone else
  here?" without a page refresh and without the client guessing.
- `peers` is a new field on `created` / `joined`: an older client ignores
  it, a newer client against an older relay reads `null` and renders the
  "unknown" state. Both directions are safe because the field is optional
  everywhere it is read.
- The room card has one primary action, so the only question left on it is
  *which room* — which is the one thing the user actually knows.