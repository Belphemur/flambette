# ADR-0040: One TypeScript relay core, two thin adapters (Bun + Durable Object)

**Status:** Proposed (2026-10-02).
**Extends:** ADR-0006 (room sync over a Bun relay), ADR-0025 (Docker
packaging — the `COPY *.mjs` glob and the CI smoke-run), ADR-0021 (three-word
room codes), ADR-0026 (join-or-create room lifecycle), ADR-0038 (the
Cloudflare hosted path).
**Not yet implemented:** this ADR is the design for the convergence; code
follows in a later PR once accepted.

## Context

The relay now ships twice: the self-hosted Bun process (`server/relay.mjs`
behind the Docker image, ADR-0025) and the Cloudflare `Room` Durable Object
(`server/worker/room.ts` behind `flambette-relay`, ADR-0038). Both speak the
same wire protocol and must obey the same lifecycle rules — join-or-create,
the rev floor, the two expiry clocks, the throttle — because a household can
have one phone on each.

Some of that contract already lives in runtime-neutral modules consumed by
both: `server/relayPolicy.mjs` (the TTL constants), `server/throttleCore.mjs`
(the throttle arithmetic), and — worker-side only — `codes.ts` re-exporting
`src/lib/roomWords.ts`. The injection seams are already in place too:
`createRoomRegistry({ inactivityTtlMs, mintCode, setTimer, now, onExpire })`
takes the clock, the randomness and the timer sink as parameters.

What did NOT converge is the state machine and the protocol. Measured on the
current tree:

| Unit | Bun side | Worker side | Shared? |
| --- | --- | --- | --- |
| Room lifecycle state machine | `roomLifecycle.mjs` (289 ln) | `worker/room.ts` (596 ln) | **no — 0 references between them** |
| Code canonicalisation | hand-maintained copy in `roomLifecycle.mjs:75` | `codes.ts` → `src/lib/roomWords.ts` | worker only |
| Protocol dispatch + error taxonomy | `relay.mjs` switch | `worker/index.ts` + `room.ts` | no |

The cost is concrete: the rev-floor, expiry and join-or-create rules exist
twice, and the Bun-side `normalizeCode` copy is hand-maintained despite the
ADRs' "structural, not hand-maintained" claim — its own comment says "keep in
step". A semantics change must be made twice and verified twice, and the CI
nets (`data:verify`, the DO specs) cannot see drift in the parts that are not
mirrored.

## Decision

0. **The persistence boundary, stated once and sharp:** the core owns
   DECISIONS (when a room expires, what a join adopts, how the rev floor
   moves), and the adapters own STATE (where bytes live). The core therefore
   speaks in intents — `touchRoom`, `storeRev`, `readFloor`, `expire` — and
   never reads or writes a Map, a table, or storage directly; each adapter
   implements those intents over its own store (the Bun registry's
   in-process Maps, the DO's SQL + alarms). This is what keeps the
   decision-table test able to run against a pure in-memory store while
   workerd proves the SQL side.
1. **One runtime-neutral TypeScript core: `server/relay-core/`.** A plain
   directory, not a workspace package — two consumers do not justify a
   workspace ceremony, and a package would add an install step to the relay
   container. Contents:

   - `protocol.ts` — the message shapes (create/join/keepalive/state/leave
     and their answers) and the `RELAY_ERRORS` taxonomy, as the single
     source. The client can import the same types the same way the worker
     already imports `roomWords.ts`, so the wire contract is checked at
     compile time on every side.
   - `lifecycle.ts` — the room state machine: the typed,
     fully-injected `createRoomRegistry`. Environment access stays OUT of
     the core: TTLs, clock, randomness and the timer sink arrive as
     parameters (the seams `roomLifecycle.mjs` already has). Storage is NOT
     in the core — the two runtimes persist differently (a process Map vs
     DO SQL storage), so the core owns the DECISIONS (when a room expires,
     what the rev floor does, what a join adopts) and exposes them through
     the same factory shape it has today.
   - `policy.ts`, `throttle.ts` — the existing `relayPolicy.mjs` /
     `throttleCore.mjs` moved to TS unchanged in behaviour.
   - `codes.ts` — re-exports `src/lib/roomWords.ts` (and `mintLegacyCode`
     moves here), deleting the hand-maintained Bun copy of `normalizeCode`.

   The module-scope rule from ADR-0038 still holds and is now structural:
   nothing in `relay-core/` may read `process.env` or import a runtime API —
   everything injected is a parameter.

2. **Two thin adapters, no shared code below the seam:**

   - `server/relay.ts` (Bun, ~120 lines): `Bun.serve`, the WebSocket
     wiring, and mapping core verdicts onto sockets. Bun executes TypeScript
     natively, so the container stays BUILD-LESS — the Dockerfile changes
     only in the COPY scope: `COPY *.mjs` widens to cover `relay-core/`
     (still a glob, never an enumerated list — ADR-0025's rule that survived
     issue #6 stays, and the CI smoke-run stays as the proof the image runs).
   - `server/worker/` keeps `index.ts` (upgrade/dispatch, hibernation) and
     `room.ts` (the DO shell: SQL persistence, alarms, `env.ROOM`), calling
     the core for every lifecycle decision. Its size drops to roughly the
     adapter + persistence shell.

3. **The Bun relay's config reads move INTO the adapter.** `relayPolicy.mjs`
   today reads `process.env.RELAY_*` at module scope — the TS core cannot
   (workerd throws), so the env fallback becomes the Bun adapter's
   responsibility, passed into the factory; the worker injects the policy
   constants directly.

4. **Test parity as the anti-drift net.** The scenario table that
   `worker/room.test.ts` already ports onto the DO (expiry, re-created room,
   rev floor, join reconciliation) becomes ONE shared decision-table test
   run against the core twice — once with a Bun-style injected clock, once
   with workerd semantics via the existing `@cloudflare/vitest-pool-workers`
   specs. The two runtime spec files remain, covering only what a shared
   core cannot see (hibernation, `SELF.fetch`, DO storage survival). A
   semantics change then fails loudly in CI instead of being caught by
   review.

## Consequences

- **One semantics owner.** The rev-floor, join-or-create and expiry rules
  stop being "same in two places" and become "one place, two adapters".
- **The line win is modest (~300 lines); the drift win is the point.** The
  honest scope: the state machine collapses; the DO's persistence and
  hibernation code does not (and should not — it is genuinely
  runtime-specific).
- **The protocol types compile-check every side**, including the SPA's
  import of the error taxonomy.
- **The Docker image stays glob-copied and smoke-run**; adding a core module
  still needs no packaging change (ADR-0025's regression guard).
- **`bun run test:unit` scope** (currently `bun test src`) widens to include
  `server/relay-core` decision-table tests, so the shared core runs on every
  push independent of the runtime suites.
- The frozen-catalog rule is untouched: nothing here touches `src/lib`
  grocery/pack logic; the only `src/` import remains `roomWords.ts`.

## Alternatives considered

- **Single runtime** (drop the Bun relay): kills the self-host Docker story
  (ADR-0038 keeps it deliberately). Rejected.
- **Runtime-neutral `.mjs` core with JSDoc**: zero-migration today, but the
  owner has chosen TypeScript for anything new, and JSDoc generics leak less
  value for the protocol shapes. The .mjs cores already shared get promoted
  to TS as part of this.
- **Bun workspace package**: cleaner imports, but adds an install step to
  the container and touches the ADR-0025 smoke contract for no behavioural
  gain over a shared directory.