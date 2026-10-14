# ADR-0088: Relay persistence — SQLite room state, per-store tables, one migration runner for both runtimes

Status: Accepted (2026-10-14) — implemented in PR #92
Extends: ADR-0040 (relay core seam — the adapters own state), ADR-0038
(the Cloudflare Durable Object path, §4 deviation), ADR-0025 (Docker
packaging), ADR-0026 / ADR-0006 (room lifecycle and sync).

**Numbering note:** 0087 was handed out on `main`'s history but is
reserved by the open branch `feat/pantry-ingredient-search` (PR #90,
`docs/design/ADR-0087-pantry-ingredient-search.md`). The global branch
scan (`git ls-tree` over every branch, per the index procedure) puts the
highest in-flight number at 0087, so this record takes 0088.

## Context

The relay ships twice — the self-hosted Bun process (`server/relay.ts`,
behind the `flambette-relay` Docker image) and the Cloudflare `Room`
Durable Object (`server/worker/room.ts`, behind `flambette-relay` on
Workers). Both speak one wire protocol and take their decisions from the
shared core (`server/relay-core/`, ADR-0040), but each owns STATE:

- **The Bun relay is volatile.** Rooms and rev floors live in in-process
  Maps (`server/relay.ts:118-126`). A container restart drops every room;
  the compose file says so in so many words ("Rooms are held in memory
  only"). The DO path has had durable state since its first deploy.
- **The DO's persistence is an opaque blob.** The whole shared snapshot —
  every synchronized store at once — sits in one `room.state` TEXT
  column. Nothing about it is queryable or column-typed, and the schema
  is managed by an ad-hoc `CREATE TABLE IF NOT EXISTS` re-checked per
  event (`#ensureSchema` / `#ensureTables`). It has ALREADY needed one
  real schema evolution: `peer_serial` became its own table purely
  because `ALTER TABLE` on an existing database needs a probe and the
  then-current code had no migration mechanism at all (the comment on
  `room.ts:99-108` records that decision).
- **What the relay actually stores is N stores, not one.** The
  synchronized payload (`SharedState`, `src/stores/room.ts`) is a bag of
  independent household stores — `plan`, `customItems`, `checked`,
  `cleared`, `customs`, `cookedHistory`, `filters`, `favorites`,
  `ratings` — with per-store semantics already on record: absence of a
  key means "don't touch", and `favorites`/`ratings` reconcile PER KEY
  by record `updatedAt`. Storage that cannot see the store boundaries
  cannot carry store-level metadata.

The owner's direction: persist the self-hosted relay (SQLite file + a
Docker volume), give BOTH runtimes one table per synchronized store with
`created_at`/`updated_at` metadata and the value as a proper JSON field,
and one clean SQLite migration story shared by both.

## Decision

### 1. The self-hosted relay persists to SQLite (bun:sqlite) behind a volume

`server/relay.ts` gains a real store over **`bun:sqlite`** — built into
Bun, so the relay's zero-runtime-dependency rule survives untouched.
Bun's `Database` API is declared structurally in the adapter (the same
move the file already makes for `Bun.serve`), because the repo ships no
`@types/bun` and ADR-0040 forbids adding one.

- `RELAY_DB_PATH` env (default `/data/relay.sqlite3`); `:memory:` is an
  explicit opt-in for tests, not the default.
- The database opens in **WAL mode** with a `busy_timeout` — a
  long-running household must not lose a write to a checkpoint stall.
- The image itself is UNCHANGED: the glob COPYs (ADR-0025, kept by
  ADR-0040) already pick up any new `relay-core/` module. What changes
  is the compose contract:

  ```yaml
  relay:
    volumes:
      - relay-data:/data        # named volume, survives re-up
    environment:
      RELAY_DB_PATH: /data/relay.sqlite3
  ```

  and `server/README.md` documents the volume (it currently advertises
  the in-memory limitation — that paragraph is deleted by the
  implementation, not edited around).

### 2. One table per synchronized store, identical shape on both runtimes

Both runtimes keep the SAME per-store schema, so a household with a
phone on each backend is stored with identical fidelity. The canonical
store list lives in the core (`SYNCED_STORES` in `relay-core/`) — the
store vocabulary is a DECISION about what the relay synchronizes, not a
storage detail, and ADR-0040 puts decisions in the core.

Nine store tables, one per `SYNCED_STORES` key (see Addendum
2026-10-14 for the two keys — `ratingTombstones`, `planIdentity` — that
implement ADR-0082 and ADR-0034 and ride the SAME per-store shape):

```sql
CREATE TABLE store_plan (
  code       TEXT PRIMARY KEY,          -- the room code
  value      TEXT NOT NULL CHECK (json_valid(value)),
  created_at INTEGER NOT NULL,          -- first write, epoch ms
  updated_at INTEGER NOT NULL           -- latest write, epoch ms
);  -- ×9: store_plan, store_custom_items, store_checked, store_cleared,
    --      store_customs, store_cooked_history, store_filters,
    --      store_favorites, store_ratings
```

- `value` is a **proper JSON field**: TEXT with a `json_valid` CHECK, so
  `json_extract` / `json_each` work against it and a corrupt write is a
  constraint failure at write time, not a surprise at read time.
  (workerd's DO SQLite must be verified to ship `json_valid` during
  implementation; if it does not, the CHECK is dropped and validation
  moves to the adapter's codec — the column stays TEXT JSON either way.)
- `created_at` / `updated_at` are per-STORE metadata: when this store
  was first and last written for this room. They are distinct from the
  room row's activity clocks (`last_activity`, `inactivity_at`,
  `idle_at`), which answer liveness questions, not history questions.
- The non-store tables keep their roles and join the versioned schema:
  `room` (rev, the two deadline clocks, serial — now with
  `created_at`/`updated_at` of its own), `rev_floor` and `peer_serial`
  (which outlive rooms and are the whole point of review F4).
- Store names get a `store_` prefix so no table name collides with a
  future SQL keyword or a domain word ("plan") used for something else.

**Why a table per store, and not one generic
`store_state(code, store, value, …)` table:** the per-store table is
where per-store evolution gets a home — a store that later needs its own
column (e.g. a per-store rev if the wire ever moves that way) adds it to
its own table without touching the others, and each store's shape is
stated in DDL rather than in a convention. The cost is named and
accepted: **adding a synchronized store is now a schema migration**, on
both runtimes, in the same change as the `SYNCED_STORES` entry.

### 3. The wire protocol is unchanged — the store split lives at the storage boundary

Clients keep pushing whole-state frames keyed by one room-wide `rev`
(ADR-0006); `favorites`/`ratings` keep their client-side per-key
reconcile. This record re-scopes STORAGE, not sync semantics — a
per-store `rev` would be a protocol change and is explicitly NOT taken
(it is recorded below as the future door the per-store tables keep open).

The split/merge therefore must be identical on both adapters, which —
per ADR-0040's boundary — makes it core code:

- `splitSnapshot(state)` → the per-store rows to write, **containing
  only the keys present in the payload** (the standing "absent = don't
  touch" rule, now enforced at the shared split, so an adapter can never
  turn a missing key into a wipe). A present `null` is NOT silence —
  `planIdentity: null` ("no current plan", ADR-0034) is written through;
  only an ABSENT key is don't-touch (see Addendum 2026-10-14);
- `joinSnapshot(rows)` → the single snapshot a `joined`/fan-out needs.

`RoomRecord.state` stays `SharedSnapshot | null` in the core; the
adapters implement `read`/`write` by joining/splitting the per-store
tables. The core's decision-table test keeps its pure in-memory store.

### 4. One migration runner in the core, applied by both runtimes

`server/relay-core/migrations.ts` owns the ordered migration list:

- Steps are **TypeScript, not `.sql` files** — the Bun image is
  build-less and has no asset filesystem to read from, and a DO bundle
  would need an import-rule exception to carry text files. Inline TS
  strings (or typed code steps) import identically into both runtimes.
- Each step is `{ version, name, statements[] }` or a typed data step
  `{ version, name, migrate(exec) }` — data reshaping (migration 002
  below) cannot be expressed as pure DDL.
- Applied versions are tracked in a **`schema_migrations` table**
  (`version INTEGER PRIMARY KEY, name, applied_at`) — not
  `PRAGMA user_version`: the runner is ONE mechanism for BOTH runtimes,
  and the DO's storage SQL does not expose user_version reliably. A
  table is also the only form that can later record per-step names for
  operator debugging.
- The runner is idempotent, applies pending steps in ascending order,
  and (as today's `#ensureTables` already insists) **verifies against
  the actual database** rather than trusting a flag: the DO can be
  evicted between events and its storage rolled back under tests.
- **Bun applies migrations at startup**, before `Bun.serve` — a relay
  that serves a half-migrated schema is worse than one that refuses to
  start. **The DO applies lazily on first event**, replacing
  `#ensureSchema`/`#ensureTables` wholesale (the lazy-apply pattern is
  forced by workerd: `ctx.storage` does not exist before the first
  event).

Migration 001 is the fresh-install schema (everything above). Migration
002 is the DO's real data migration: for each store, split the existing
`room.state` blobs into per-store rows — `INSERT INTO store_x SELECT
code, json_extract(state, '$.x'), created_at, updated_at …` per store —
then `UPDATE room SET state = NULL`. The column is left in place
(deprecated, always NULL afterwards) rather than dropped: an additive
step cannot fail on any workerd SQLite vintage, and the peer_serial
precedent shows additive beats clever here. The Bun side ships migration
002 as a no-op — it has no pre-existing rows to split — but carries the
same step so both runtimes agree on the version history.

### 5. The expiry behaviour converges: both adapters keep rooms until the clocks fire

With durable state, the Bun relay stops deleting a room when its last
peer leaves and adopts the DO's ADR-0038 §4 behaviour: the row survives
until the 24h inactivity clock or the 7-day idle backstop fires, so a
phone that reconnects after a tunnel, a reload, or (new) a relay restart
gets its plan back instead of re-seeding an empty room. This CLOSES the
one deliberate behavioural difference between the adapters — after this
record, "the two relays differ behaviourally" has no entry left. A
restart is now a resumption: the rev floor and serial survive in the
database, so a re-created room still cannot pass a stale snapshot off as
newer (review F4) and peer ids still never repeat within a code.

Throttle buckets stay in memory deliberately: rate-limit state is
ephemeral by design, and persisting it would make a restart BOTH a
pardon and a weapon.

### 6. Gates

- The core's decision-table suite (`bun run test:unit`, scoped to
  `server/relay-core`) extends to cover `splitSnapshot`/`joinSnapshot`
  and the migration runner against a test in-memory store.
- The DO specs (`bun run test:worker`) prove the same runner on workerd:
  fresh schema, and the blob-split 002 over a pre-seeded `room.state`.
- A new Bun-side spec opens `bun:sqlite` against a `:memory:` database
  and replays the same scenarios (restart survival: close and reopen).
- E2e is unchanged — the wire protocol did not move — but the
  registry-coverage guard keeps watch on the store vocabulary:
  `SYNCED_STORES` and the client's `SharedState` keys must agree, and
  the implementation adds that cross-check where the core can see both.
- Packaging: the CI docker smoke-run (ADR-0025) points
  `RELAY_DB_PATH` at a temporary path and asserts the SQLite file
  exists after a create + state push — proving the volume story without
  a volume.

## Consequences

- **Self-hosted rooms survive restarts.** The compose limitation note
  becomes obsolete; `docker compose up -d` on an upgraded relay resumes
  rather than resets.
- **The DO's state becomes inspectable.** A household's per-store data
  is one `SELECT` with `json_extract`, instead of parsing a blob by
  hand in a review.
- **Store metadata is now first-class** — `created_at`/`updated_at` per
  store per room, on both backends, instead of nothing.
- **Adding a synchronized store now costs a migration on two runtimes**
  (the named cost of per-store tables). The runner makes that cost
  mechanical, not risky.
- **Schema evolution has a real mechanism** instead of the
  `CREATE TABLE IF NOT EXISTS` dance that already produced the
  peer_serial workaround.
- `docs/agents/rooms-and-sync.md` and `docs/agents/packaging-and-deploy.md`
  update in the implementation change (the standing "topic doc in the
  same change" rule); this record carries only the decision.
- The DO carries one deprecated column (`room.state`, NULL-filled) until
  a future migration removes it.

## Addendum (2026-10-14): eleven stores, not nine — twelve as of ADR-0090; `planIdentity` is always-sent

**Store count update (2026-10-14, PR #92):** the pantry became the
TWELFTH synchronized store (ADR-0090, superseding ADR-0087 Decision 7),
adding `store_pantry` via migration 003 of the folder-shaped migration
engine. The lists below read twelve keys / twelve tables as of that
change; the reasoning text is kept as written.

Implementation of ADR-0088 surfaced a contract error in §2/§3: the relay's
`SYNCED_STORES` (the runtime mirror of the client `SharedState` in
`src/stores/room.ts`) contains **eleven** keys, not nine. The two the ADR
omitted both attach payload semantics the record already relies on —

- **`ratingTombstones`** (ADR-0082): `Record<string, number>` — the
  deletion half of `ratings`; additive, published every snapshot while
  non-empty.
- **`planIdentity`** (ADR-0034): `{ planId, planCreatedAt } | null` —
  **always sent**; `null` is a real value ("no current plan"), distinct
  from the key being ABSENT ("older peer has nothing to say", ADR-0028).

Consequence for §3: the "absence = don't touch" rule has an explicit
exception — a missing `planIdentity` key stays don't-touch, but an
explicit `planIdentity: null` is a PRESENT value and is written through.
The core enforces this by writing every `SYNCED_STORES` key whose value
is `!== undefined`; `undefined` (the parsed-JSON equivalent of omission)
is silence, a real `null` is data. The eleven per-store tables are:
`store_plan`, `store_custom_items`, `store_checked`, `store_cleared`,
`store_customs`, `store_cooked_history`, `store_filters`,
`store_favorites`, `store_ratings`, `store_rating_tombstones`,
`store_plan_identity`.

**No implementation change follows this correction:** `server/relay-core/stores.ts` already enumerates all eleven keys and already implements the
exception — the `splitSnapshot` loop writes any key `present` and its
comment pins `null` as a real value. The agreement is gated both ways:
a compile-time assertion in `src/stores/room.ts` (mirrors `roomSyncStores.ts`
or fails `bun run build`) and the test-time cross-check in
`stores.test.ts` (fails `bun run test:unit` when the lists disagree). This
Addendum only brings the prose back in line with the shipping code. The
store-adding procedure (`.agents/skills/mealime-add-sync-store/SKILL.md`)
touch surface (its step 5 and the Pitfalls) is aligned to the same
eleven and to the `planIdentity` always-sent exception.

**Resolved-at-impl note on §2's `json_valid` caveat:** the store tables
carry `value TEXT NOT NULL CHECK (json_valid(value))` in the SHARED DDL
(`storeTableDdl` in `server/relay-core/migrations.ts`) with no runtime
probe, so both adapters run the identical `CREATE TABLE`. This is safe
because `bun run test:worker` exercises that DDL against workerd's real
`ctx.storage.sql` — the DO spec creates a store table with the CHECK on a
fresh database in the workerd pool and passes — so `json_valid` IS
available in workerd's bundled SQLite and the codec-side fallback the
ADR hedged ("if absent, drop the CHECK") was never taken.

## Alternatives considered

- **One generic `store_state(code, store, value, …)` table.** Cheaper to
  extend (a new store is a row value, not DDL) but per-store metadata
  and evolution land in convention instead of schema; the owner asked
  for table-per-store explicitly, and its evolution story is the
  stronger long-term one. Rejected.
- **D1 (Cloudflare SQL database) for the Cloudflare path.** Changes the
  topology ADR-0038 deliberately chose — one DO per room code gives
  per-room storage isolation, single-writer serialisation and
  `idFromName` routing for free. D1 would also make the two runtimes'
  storage APIs converge LESS (Bun cannot speak D1's HTTP protocol
  without a dep). Rejected.
- **`PRAGMA user_version` for migration tracking.** Cleanest in plain
  SQLite, but not portable to the DO, and one shared mechanism is the
  point of this record. Rejected.
- **A migration library (drizzle-kit, dbmate, Knex).** Every candidate
  is a new runtime dependency for the relay (the zero-dep rule surfaces
  the trade-off first), assumes an fs or build step the build-less Bun
  image does not have, or targets ORMs the relay deliberately does not
  use. The hand-rolled runner is ~80 lines and lives beside the
  decisions it migrates. Rejected.
- **Keep the blob, add only metadata columns.** Carries the dates but
  leaves every store in one unqueryable value and keeps "adding a store"
  invisible to storage. Rejected.
- **Persist throttle buckets too.** Rejected: ephemeral by design (§5).
