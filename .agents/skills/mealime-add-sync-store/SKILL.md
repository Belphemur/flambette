---
name: mealime-add-sync-store
description: Add a synchronized household store to the relay, ADR-0088 — every surface that must move in the same change.
version: 1.0.0
author: Antoine Aflalo (Belphemur), Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Mealime, Relay, Rooms, SQLite, Store, flambette]
    related_skills: [mealime-planner-dev, flambette-adr-records, mealime-add-recipe]
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
  ADR or a dated Addendum on the governing record (see
  `flambette-adr-records`).
- Don't use for: device-local stores that never ride the relay (they
  only need a Pinia key + a `STORE_SLICES` entry — see backup.ts), or
  relay storage questions that don't change the payload.

## The touch surface (all of it, one change)

### Client side

1. **The store itself** — `src/stores/<name>.ts` (Pinia, persisted under
   `mealime-planner:v1:*`).
   Completion criterion: state, actions and the persist key exist.
2. **`SharedState` in `src/stores/room.ts`** — the new key. The payload
   evolves ADDITIVELY (ADR-0012 rule): the key is OPTIONAL, absence
   means "don't touch" (never a wipe), and it is emitted only when
   non-empty unless the store has its own tombstone semantics (see
   `favorites`). Types are MIRRORED from the server, never imported
   live (`server/` is outside the client's import graph).
   Completion criterion: an old relay/client combination degrades
   gracefully — an old peer ignores the unknown key, a new peer reading
   an old peer's payload keeps its own data.
3. **`snapshot()` / `applyRemote()` in the same file** — state the merge
   semantics HERE, explicitly: whole-state LWW under the room `rev` (the
   default), or per-key reconcile by record `updatedAt` with tombstones
   (the `favorites`/`ratings` shape — mandatory for stores where two
   peers editing DIFFERENT keys must not clobber each other, and where
   an un-do must propagate as a delete marker, not silently resurrect).
   Completion criterion: you can name which semantics you chose and why.
4. **`STORE_SLICES` in `src/lib/backup.ts`** — the standing ADR-0013
   rule, unchanged by ADR-0088: every persisted slice registers in the
   SAME change. Export, import and validation all iterate the registry.
   Completion criterion: the e2e registry-coverage case passes —
   `assertRegistryCoverage` fails loudly otherwise.

### Relay side (ADR-0088's per-store storage)

5. **`SYNCED_STORES` in `server/relay-core/`** — the canonical store
   vocabulary the core owns. The client's `SharedState` keys and this
   list must agree; the core carries the cross-check gate (ADR-0088 §6)
   and it fails on drift.
   Completion criterion: the cross-check passes on `bun run test:unit`.
6. **A migration for BOTH runtimes** — a new versioned step in
   `server/relay-core/migrations.ts` creating `store_<snake_name>`
   (`code TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)),
   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`). Steps are
   inline TypeScript, applied by ONE runner: Bun at startup, the DO
   lazily on first event. Never hand-run DDL against a live database and
   never renumber a shipped migration.
   Completion criterion: the bun:sqlite spec AND the DO spec
   (`bun run test:worker`) both prove the new table on a fresh database
   AND on a database that already had the previous schema version.
7. **The split/merge is automatic IF the store follows the rules** —
   `splitSnapshot`/`joinSnapshot` in the core key off `SYNCED_STORES`,
   so no adapter code changes. It is NOT automatic if the store carries
   server-side reconcile logic — keep reconcile on the CLIENT; the relay
   stores and fans out.
   Completion criterion: no new adapter code (a diff that touches
   `server/relay.ts` or `server/worker/room.ts` for a plain new store is
   a smell — stop and ask why).

### Docs

8. **`docs/agents/rooms-and-sync.md`** — the shared-state key list and
   the store's merge semantics, in the same change (standing rule: the
   topic file and the code move together; stale docs are bugs).
9. **ADR** — a plain new store that follows the standing rules does NOT
   need a new ADR (this skill is the procedure, ADR-0088 is the design
   record); one that re-scopes semantics (per-store rev, server-side
   reconcile, a store that opts OUT of absence-means-don't-touch) does.
   Then regenerate the index (`bun run data:adr-index`) and let
   `--check` gate it.
   Completion criterion: `python3 scripts/build_adr_index.py --check`
   passes.
10. **`AGENTS.md` is NOT touched** for the store itself (entry point
    only); update its "Repo skills" row only if you added a skill.

## Gates (in order, before "done")

1. `bun run test:unit` (core decision table + the new cross-check).
2. `bun run build` (type-check wires the mirrored types).
3. `bunx playwright test e2e/backup.spec.ts` (or the registry-coverage
   case) — the store must not disappear from backups.
4. Full suite per the e2e gate discipline BEFORE the final push
   (`docs/agents/e2e.md` — full suite ONCE, reconciled against `--list`).

## Pitfalls

- **The two vocabularies drift.** Adding the key to `SharedState` but
  not `SYNCED_STORES` makes the relay drop it from storage on one
  runtime and keep it on the other — silent household data loss on
  restart. The cross-check gate exists because this exact drift is the
  failure; do not weaken the gate to make a partial change pass.
- **A required store marked optional.** "Optional" in `SharedState`
  means backward compatibility, not skippable backup. If the store must
  ride every payload, say so in the type comment and still register the
  slice.
- **Tombstone-less per-key reconcile.** A per-key store without delete
  markers (`{…, updatedAt}` + an absent-key-is-keep rule) cannot
  propagate an un-<thing>: the next push resurrects it. Copy the
  `favorites` record shape, don't invent a fourth scheme.
- **Client-side reconcile broken by server-side storage.** The relay's
  per-store tables are STORAGE rows, not reconcile participants — the
  relay never merges per-key on the server's behalf (ADR-0088 §3).
  Adding server-side merge is a protocol change; new ADR.
