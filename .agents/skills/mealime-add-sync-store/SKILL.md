---
name: mealime-add-sync-store
description: Add a room-synced household store across all touch surfaces.
version: 2.0.0
author: Antoine Aflalo (Belphemur), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Mealime, Relay, Rooms, SQLite, Store, flambette]
    related_skills: [mealime-add-recipe]
---

# Add a Synchronized Store to the Relay

Procedure for adding a NEW store to the household sync payload — a piece
of state that travels through the relay and persists in BOTH runtimes'
SQLite storage. ADR-0088 made storage per-store: every synchronized key
has its own table on the Bun relay AND in the Durable Object, so "add a
key to the payload" is no longer a one-file change. Missing ONE surface
below is the failure mode this skill exists to prevent — the store would
sync but not back up, or sync on the client but be silently dropped (or
crash) at the relay's storage boundary.

## When to Use

- Adding a new synchronized store (a new `SharedState` key).
- Changing an EXISTING store's semantics (e.g. whole-state LWW →
  per-key reconcile) — that re-scopes behaviour: run this PLUS a new
  ADR or a dated Addendum on the governing record (see the repo's ADR
  records skill).
- Don't use for: device-local stores that never ride the relay (they
  only need a Pinia key + a `STORE_SLICES` entry — see `backup.ts`), or
  relay storage questions that don't change the payload.

## Prerequisites

- A checkout of the flambette repo with `bun` installed.
- The governing design record read first (ADR-0088 for the storage
  model; ADR-0090 for the newest precedent — the pantry, whole-state
  LWW like `customs`).
- For a semantics change beyond a plain new store: the ADR record
  number reserved BEFORE coding (the repo's ADR workflow — `--next`,
  never counted).

## How to Run

Work from the repo root via the `terminal` tool. Gates at the end run
as `terminal(command="bun run test:unit", timeout=...)` and friends;
file edits go through `patch` (small deltas) or `write_file` (new
files); discovery through `search_files`.

## Quick Reference

- Vocabulary (server): `server/relay-core/stores.ts` → `SYNCED_STORES`
- Vocabulary (client mirror): `src/lib/roomSyncStores.ts` →
  `SHARED_STATE_KEYS`
- Interface: `SharedState` in `src/stores/room.ts` (build-time
  cross-checks both directions)
- Snapshot plumbing: `snapshot()` / `applyRemote()` in the same file
- Backup registry: `STORE_SLICES` in `src/lib/backup.ts`
- Migration module: `server/relay-core/migrations/<NNN>_<name>.ts`
- Gate order: `bun run test:unit` → `bun run build` →
  `bun run test:worker` → backup e2e → full e2e once

## Procedure

1. **Server vocabulary.** Add the key to `SYNCED_STORES` in
   `server/relay-core/stores.ts`, in the order the client declares it.
   Split, merge and the write planner key off this list — no adapter
   code changes for a plain new store.
   Completion criterion: a diff that touches `server/relay.ts` or
   `server/worker/room.ts` for a plain new store does NOT exist (a
   smell — stop and ask why).
2. **Migration module.** Create
   `server/relay-core/migrations/<NNN>_<name>.ts` — ONE module per
   migration, next version in sequence — exporting its
   `{ version, name, expects?, up, down, migrate? }` step. `up` carries
   the forward SQL as template literals:
   `CREATE TABLE IF NOT EXISTS store_<snake_name> (code TEXT PRIMARY KEY,
   value TEXT NOT NULL CHECK (json_valid(value)), created_at INTEGER NOT
   NULL, updated_at INTEGER NOT NULL)` (build the table name with
   `storeTableName`, never by hand). `down` drops exactly what `up`
   created — the runner applies it ONLY via the explicit `rollbackTo`
   ops entry point, never automatically. A data reshape that cannot be
   a static SQL list registers the typed `migrate` hook (up) /
   `migrateDown` hook (down) instead (see `002_split_state_blobs.ts`).
   Register the module in the ordered `MIGRATIONS` list in
   `server/relay-core/migrations.ts`. Never renumber or reorder a
   shipped step; never hand-run DDL against a live database.
   Completion criterion: `bun test server/relay-core/migrations.test.ts`
   passes with the new version in the ledger, on a fresh database AND
   on one that already had the previous schema version (partial-DB
   pending detection covers the tail).
3. **Client mirror.** Add the key to `SHARED_STATE_KEYS` in
   `src/lib/roomSyncStores.ts`.
   Completion criterion: `bun run build` passes — the compile-time
   assertion in `src/stores/room.ts` fails the build on drift in EITHER
   direction, so a one-sided addition cannot ship.
4. **`SharedState` + plumbing in `src/stores/room.ts`.** Add the key
   OPTIONAL (`key?: Row[]`) with a comment stating the never-a-wipe
   rule: absence means "don't touch" (an older peer keeps its own).
   Emit it from `snapshot()` (always, like `customs`, for plain
   whole-state stores) and adopt it in `applyRemote()` behind
   `if (state.key)` through the store's normalization funnel — a peer
   payload can never bypass the store's invariants. Add the store's
   state ref to the debounced push watcher.
   Merge semantics are decided HERE, explicitly: whole-state LWW under
   the room `rev` (the default — `customs`, `pantry`), or per-key
   reconcile by record `updatedAt` with tombstones (the
   `favorites`/`ratings` shape — mandatory when two peers editing
   DIFFERENT keys must not clobber, and an un-do must propagate as a
   delete marker).
   Completion criterion: you can name which semantics you chose and
   why, in one sentence.
5. **Pinia store.** The store itself (`src/stores/<name>.ts`) already
   exists or is created with its persist key
   (`mealime-planner:v1:<name>`), normalization funnel and
   `afterHydrate` repair.
   Completion criterion: `bun test src/stores/<name>.test.ts` covers
   the funnel (re-derived keys, dedupe, cap).
6. **Backup registry.** Every persisted slice registers in
   `STORE_SLICES` (`src/lib/backup.ts`) in the SAME change (ADR-0013).
   Completion criterion: the e2e registry-coverage case passes —
   `assertRegistryCoverage` fails loudly otherwise.
7. **Docs, same change.** `docs/agents/rooms-and-sync.md` (the shared
   state key list + the store's merge semantics); the ADR record (a
   plain store following the standing rules does NOT need a new one —
   a semantics re-scope does); regenerate the index
   (`python3 scripts/build_adr_index.py`). `AGENTS.md` is NOT touched
   for the store itself.
   Completion criterion: `python3 scripts/build_adr_index.py --check`
   passes.

## Pitfalls

- **The two vocabularies drift.** Adding the key to `SharedState` but
  not `SYNCED_STORES` makes the relay drop it from storage on one
  runtime and keep it on the other — silent household data loss on
  restart. The cross-check gates exist because this exact drift is the
  failure; do not weaken a gate to make a partial change pass.
- **A required store marked optional.** "Optional" in `SharedState`
  means backward compatibility, not skippable backup. If the store
  must ride every payload, say so in the type comment and still
  register the slice.
- **Tombstone-less per-key reconcile.** A per-key store without delete
  markers (`{…, updatedAt}` + an absent-key-is-keep rule) cannot
  propagate an un-<thing>: the next push resurrects it. Copy the
  `favorites` record shape, don't invent a fourth scheme.
- **Client-side reconcile broken by server-side storage.** The relay's
  per-store tables are STORAGE rows, not reconcile participants — the
  relay never merges per-key on the server's behalf (ADR-0088 §3).
  Adding server-side merge is a protocol change; new ADR.
- **`json_valid` is real on workerd.** The store-table CHECK ships in
  the shared DDL with no probe; `bun run test:worker` verifies it
  against workerd's real `ctx.storage.sql`. Do not soften the CHECK to
  a runtime codec check unless a workerd vintage regresses — and then
  file an ADR, not a workaround.
- **Silencing an explicit `null`.** "Absence = don't touch" does NOT
  mean "a present `null` is dropped" — `planIdentity: null` ("no
  current plan", ADR-0034) is a real answer that must round-trip
  through split/join. Encoding absence and explicit-null the same way
  wipes a meaningful plan-reset.
- **A rollback down-list that outlives its era.** A migration's `down`
  may only touch objects from its OWN version's world: 002's fold
  skips stores whose tables a later migration created and an earlier
  rollback step already dropped (see `migrateDown`). A static `down`
  list generated from the LIVE vocabulary breaks the first time a
  rollback crosses a later store's migration.

## Verification

- `terminal(command="bun run test:unit")` — core decision tables, the
  new-store cross-check, migration pending/down specs. Expect 0 fail.
- `terminal(command="bun run build")` — the mirrored-types build-time
  cross-check. Expect clean.
- `terminal(command="bun run test:worker")` — the DO applies the same
  migration list against real workerd storage. Expect 0 fail.
- `terminal(command="bunx playwright test e2e/backup.spec.ts")` — the
  store must not disappear from backups.
- Full suite per the e2e gate discipline BEFORE the final push (full
  suite ONCE, reconciled against `--list` — see `docs/agents/e2e.md`).