# ADR-0013: Backup & restore — single-file zip, STORE_SLICES registry, atomic import

Date: 2026-09-27 (phase 14)
Status: Accepted

## Context

Users have no way to move their whole app state between devices or keep
an offline copy. All app state lives in localStorage under
`mealime-planner:v1:*` keys via pinia-plugin-persistedstate. The app is
offline-first; there is no cloud, no account, no sync service beyond the
unreliable live rooms.

## Decision

1. **Manual backup file, not cloud/sync.** Export downloads one file,
   import restores it. No server ever sees your state — backup is the
   user's own archive and carries personal slices (cooked history,
   remembered custom ingredients) regardless of room-sync settings.
2. **ZIP container, one JSON per slice, NOT one big JSON.**
   `mealime-planner-backup-YYYYMMDD.zip` contains `meta.json`
   (`{app:"mealime-planner", schema:1, exportedAt}`) plus one file per
   registered slice (plan.json, checked.json, cooked-history.json,
   custom-ingredients.json, settings.json, favourites.json). Per-file
   slices are inspectable, diffable, and independently evolvable
   (schema-bumpable) compared to one opaque blob. A future migration can
   regenerate only the slices whose shape changed, and a corrupt slice
   names itself in the error instead of failing an unattributable parse.
3. **One STORE_SLICES registry (DRY wins).** `src/lib/backup.ts` holds a
   single `STORE_SLICES` list — name/file → `{persistKeys, read, write,
   validate}`. Export, import AND validation all iterate the same
   registry; there is no parallel list anywhere. Adding a persisted
   store slice without registering it fails every export loudly
   (assertRegistryCoverage compares localStorage `mealime-planner:v1:*`
   keys against the registry at export time) and is also a standing
   AGENTS.md rule enforced by an e2e case.
   - The loser (KISS "just hardcode an array in one place, import code
     walks it opaquely") was rejected because import needs per-slice
     validation anyway, and duplicated read/validate lists inevitably
     drift — the r-grocery list already went through that lesson (see
     ADR-0003 derivation rule).
   - SOLID was implicitly respected but not chased: the registry is one
     module, not an interface taxonomy.
4. **Zero-dep zip codec, not JSZip.** JSZip was NOT already a
   dependency; adding a runtime dep for stored (uncompressed) entries
   was a poor trade — the stored-zip byte layout is ~120 lines
   (src/lib/zip.ts) with a CRC-32 table and a central-directory reader.
   Entries are STORED-only: device sizes are trivial (max ~200 cooked
   rows), and compression would only add failure modes. State surfaced
   here per the owner's rule (no silent new deps).
5. **Atomic, validation-first import.** The entire archive (meta app-tag
   + schema + every present slice) is parsed and validated BEFORE the
   first store mutation; one bad file rejects the whole backup with the
   reason toasted. Missing slice files are tolerated and re-apply the
   current state (no wipe-to-empty surprise) — present-but-invalid
   files are NOT tolerated. A confirm dialog states the overwrite scope.
6. **Checked-map semantics.** All checked keys restore verbatim.
   Stale keys (lines not derived from the restored plan) are inert —
   the grocery list is DERIVED, so unmatched keys never render — and
   keeping them means a re-planned meal restores its checkmarks.
7. **Room boundary.** Import is a LOCAL overwrite. If the device is in a
   live room, the repl State (plan/checked/customs/cleared) re-pushes to
   peers via the normal debounced watcher — rooms keep syncing live
   state afterward. cookedHistory always lands in the backup; it only
   enters a room payload when the sender opted in (ADR-0011 addendum).
8. **Theme bridge.** Dark-mode override persists via vueuse useDark
   under `vueuse-color-scheme`, not a Pinia slice — bridged read/write
   inside the settings slice so backups carry the override.

## Consequences

- Export is one click, works on plain-HTTP LAN origins (a plain
  `<a download>` object URL — no clipboard/web-share dependence).
- Backups are reproducible: re-export of an unmutated state is
  byte-stable for plan/checked/cooked slices (pinned by e2e).
- New persisted stores must register (AGENTS.md rule) or export fails.
- schema stays 1 until a migration exists; BUMP and migrate never
  silently drop slices.

## e2e Coverage

`e2e/backup-restore.spec.ts`: full round-trip (plan, checkmarks, cooked
history, custom-ingredient "mine" memory, favourites, theme), stable
re-export byte equality, atomic rejection of damaged/wrong-tag archives,
filename pattern, and the registry-coverage loud-failure case.
