# ADR-0094: Object-JSON cleared-ingredient storage (serving-safe clear-checked)

Status: accepted (2026-10-18)

## Context

`main` (`786cbed`) ships the `bec21a9` grocery filter (PR #96), which hides a
clear-checked line by identity only when that identity maps 1:1 to a rendered
line (`grocery.ts:528-544`). That guard closed the K5 sibling-swallow but left
**two HIGH findings live**: the "Serving-stale HIGH" — a cleared line
reappears after a servings change. PR #97 (`fix/k5-redo`, `lineSpecific`) was
opened as a redo but is abandoned — superseded by the redesign below.

A read-only investigation (`flambette-grocery-storage-investigation`; report
at `/tmp/flambette_grocery_storage_report.md`) traced the full surface —
`grocery.ts:216-246` (`lineKeyBasis`) and `grocery.ts:246-270`
(`lineKeyIdentity`), the render filter `grocery.ts:528-544`,
`plan.ts:107` (`clearedIngredients`), `plan.ts:529-542` (persisted `pick`),
`backup.ts:676-681` (`isClearedMap`), `room.ts:376/450/650` (sync) — and
reduced all three bugs to ONE structural failure.

**The stored cleared state is the *rendered basis* (`nameKey||basis`, e.g.
`egg||4`, `soy sauce||3 tbsp`), not a stable identity.** Two consequences:

1. **Identity derivation is lossy.** `lineKeyIdentity` collapses distinct
   grammatical classes to one identity. Real catalog cases:
   - `egg||4` (unitless) + `egg||6 to taste` (unitless) → both `egg||`
     (the serving-stale path is the *unitless* egg rotation; a by-unit
     soy-sauce line with a unique identity is already hidden correctly by
     `#96`).
   - `milk||1 cup` + `milk||1cup` → both `milk||cup`.
   - `soy sauce||1 pkg` from two recipes → both `soy sauce||pkg` (the
     container sibling-swallow).
   The `lineKeyIdentity` docblock's "unique per unit identity" claim is
   falsified by these cases.
2. **The basis rotates.** Any composition or servings change re-sums the
   line (`egg||4` → `egg||8`, `soy sauce||3 tbsp` → `soy sauce||2 tbsp`) —
   the persisted string no longer matches the rendered line.

The filter is forced to *guess string shapes* (`lineCleared` /
`lineIdentityCleared` / `lineSpecific`) to approximate "hide the line I
cleared" vs "hide only my sibling," and it guesses differently under
different implementations — `#96` and `#97` each fix one bug and
reintroduce the other, which is exactly the `bec21a9 → #97` churn
signature of a lossy identity model being patched, not fixed.

## Decision

Replace the persisted cleared state from `Record<number, string[]>` to
`Record<number, ClearedIngredient[]>`, where each entry carries a
**stable, discriminated identity** plus the clear-time serving context, so
render can re-derive the successor key deterministically instead of
string-matching a stale render.

```typescript
// src/stores/grocery.ts (co-located type)
export interface ClearedIngredient {
  /** BASE doc nameKey, e.g. `egg`, `soy sauce` (never the rendered `||basis`). */
  keyName: string
  /** Grammar class of the cleared line; discriminates the identity bucket. */
  unit:
    | { kind: 'byUnit'; unit: string }                 // parsed quantity, e.g. `tbsp`, `ml`
    | { kind: 'container'; noun: string; annotation: string } // container noun, e.g. `pkg`, `142 g`
    | { kind: 'raw'; basis: string }                   // unparseable `raw||` row, e.g. `to taste`; basis preserved verbatim
    | { kind: 'row' }                                  // whole-ingredient clear (bare nameKey)
  /** Clear-time factor = entryServings / recipe.baseServings. */
  factor: number
  /** Serving count the plan held at clear time. */
  servingsAtClear: number
  /** `line` = hide one line; `ingredient` = clear the whole ingredient group. */
  scope: 'line' | 'ingredient'
}
```

Render consumption (`aggregateGroceries`, via `useGroceryList.ts`): for each
entry, compute the *successor key* the render will produce by scaling
`factor`/`servingsAtClear` against the **current** plan factor; hide rendered
lines that exact-match a successor key. The grammar class + clear-time amount
make the successor key deterministic — **no ratio guessing, no display-shape
heuristics**.

- `factor`/`servingsAtClear` together kill Serving-stale (the successor is
  computed, not matched against a stale string).
- The discriminated `unit.kind` kills K5 (a `raw`/`to-taste` line and a
  by-unit line no longer collapse to one identity).
- `scope: 'ingredient'` hides the whole group.

Storage surface:

- `plan.ts:107` — `ref<Record<number, ClearedIngredient[]>>`.
- Persist `pick` (`plan.ts:529/535-542`) — unchanged shape handling; Pinia
  serializes objects as-is. Cleared state survives backup because it lives in
  the persisted `pick`.
- `backup.ts:676-681` (`isClearedMap`) / `PlanSnapshot` — accept **both**
  `string[]` (legacy) and `ClearedIngredient[]` (new); legacy blobs run the
  load-time migration.
- **Room-sync wire (protocol change).** `room.ts:376` snapshots `cleared`;
  `room.ts:450` applies `state.cleared`; `room.ts:650` watches
  `clearedIngredients`. New peers emit a `clearedV2` key (object array)
  **alongside** the legacy `cleared`; a peer applies whichever key is present
  and runs the string→object migration on legacy input. ADR-0088 per-store
  SQLite persistence is additive-tolerant, so a mid-flight peer never drops a
  clear.
- Load-time migration: `string[]` → `ClearedIngredient[]` by parsing
  `nameKey||basis`, classifying the basis into `byUnit`/`container`/`raw`/
  `row`, stamping `scope: 'line'` for `nameKey||basis` keys and
  `scope: 'ingredient'` for bare nameKeys, and filling `factor`/`servingsAtClear`
  from the **current** plan state (approximation for legacy blobs — the object
  model makes a recipe-catalog-derived value possible later, but the
  current-plan approximation is correct for the common case and strictly no
  worse than the current string model).

`setServings` (`plan.ts:197-200`) remap is **obsoleted** — the successor key
is derived at render from `factor`/`servingsAtClear`, so no stored key needs
rewriting on servings change.

## Consequences

- Fixes all three bugs (K5 sibling-swallow, Serving-stale HIGH, Sibling-
  vanish) and the restriction-overlay `raw`/`to-taste` collision in one move.
- Eliminates the 3-branch string-shape guessing in the filter
  (`grocery.ts:528-544` collapses to an exact successor-key match; the
  `lineKeyIdentity` fallback is removed).
- **Wire-protocol break** at `room.ts:376/450/650` — mitigated by the additive
  `clearedV2` field + dual-shape accept (older peers keep emitting/accepting
  `cleared` strings).
- Migration blast radius is concentrated: `grocery.ts:528-544` (filter
  rewrite, riskiest — must be provably equivalent for the non-colliding
  case), `plan.ts` (type + 4 mutation sites: 234-241 / 255-263 / 271-273 /
  406-425), `backup.ts` (validator + `PlanSnapshot` type), `room.ts` (3 wire
  sites), plus unit (`plan.test.ts:239-283`) and e2e. Backward-compat:
  persisted `string[]` blobs migrate on load.
- Render keys (`egg||4`, `soy sauce||3 tbsp`) are **unchanged** — only the
  *cleared state* becomes objects, so ingestion/render paths
  (`grocery.ts:306-329`) are untouched.

## Alternatives considered

- **Minimal rescale (keep string keys; re-rescale the cleared basis on servings
  change via `scaleSeasoningAware`).** Rejected. Fixes Serving-stale but
  **cannot fix K5** — the identity collision (`egg||4` + `egg||6 to taste` →
  `egg||`) is inherent to the `||` grammar, not to a stale factor. Zero wire
  break, but a patch on a structurally broken model; the
  `bec21a9 → #97` churn is the evidence it cannot converge.
- **Local-only object (persist objects; keep emitting `string[]` on the room
  wire).** Rejected as the default but **retained as a release-cycle escape
  hatch (Appendix A)**: if the wire break is blocked, ship objects locally and
  derive/accept legacy strings on the wire. Halves blast radius at the cost of a
  permanent legacy tax.

### Appendix A — escape hatch: local object, legacy wire
Emit `cleared` as `string[]` derived from the `ClearedIngredient[]` objects at
snapshot time (`room.ts:376`); apply `state.cleared` by running the
string→object migration at `room.ts:450`. All three bugs fixed locally; older
peers unaffected because the wire never changes. Acceptable only if the full
`clearedV2` versioning is deferred.
