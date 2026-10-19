# ADR-0094: Object-JSON cleared-ingredient storage (serving-safe clear-checked)

Status: accepted (2026-10-18) — implemented in https://github.com/Belphemur/flambette/pull/98

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
    | { kind: 'byUnit'; unit: string; amount: number }                 // parsed quantity + its captured basis, e.g. `tbsp`, 2
    | { kind: 'container'; noun: string; annotation: string; count: number } // container noun + captured count, e.g. `pkg`, ½
    | { kind: 'raw'; basis: string }                   // unparseable `raw||` row, e.g. `to taste`; basis preserved verbatim
    | { kind: 'row' }                                  // whole-ingredient clear (bare nameKey)
  /** Clear-time factor = entryServings / recipe.baseServings. */
  factor: number
  /** Serving count the plan held at clear time. */
  servingsAtClear: number
  /** `line` = hide one line; `ingredient` = clear the whole ingredient group. */
  scope: 'line' | 'ingredient'
  /** Legacy string migrations only: identity-presence claim, amount advisory. */
  approx?: true
}
```

The `amount`/`count` payloads and the context fields are INFORMATIONAL
(review addendum below): they spell what was cleared and feed the legacy
`nameKey||basis` wire spelling, but the line filter never matches against
them — the successor comes from the claiming variant's own current render.

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

## Addendum (2026-10-19, PR #98 review round) — successor = the render itself; legacy = identity claims; wire freshness by disagreement

The review round surfaced six defects in the first implementation. Three of
them shared one root cause — the successor prediction re-implemented the
render's math instead of reusing it — and the fixes replace that math with the
render itself.

**1. The successor is the claiming variant's OWN CURRENT RENDER (the shadow
aggregation).** The first implementation predicted the successor as
`capturedAmount × (servingsNow / servingsAtClear)` — a linear ratio applied to
an already-rendered value. That diverges from the render three ways: the
ADR-0017 container ceiling was re-applied to a CEILED count (clear at factor 3
of a ½-pkg row captured 2 pkgs; back at factor 2 the render produces
`ceil(½×2) = 1` but the prediction produced `ceil(2×⅔) = 2` — the cleared line
reappeared); seasonings scale sub-linearly (ADR-0009) and metric amounts
quantize (ADR-0057's `scaleMetricAmount`), so `2129 ml ×⅔` renders `1420 ml`
while the ratio spelled `1419.3`; and per-row sums cannot be recovered from a
summed basis. The fix: `aggregateGroceries` extracts its ingestion half into
`buildGroups`, and for every variant holding exact claims runs the SAME
ingestion on that variant alone at the CURRENT factor — the shadow. A claim
contributes its shadow line's key amount (the numeric sum, not a re-parsed
spelling) to a `(keyName, identity)` bucket; the merged line hides iff the
claimed shares sum to exactly what the merged render spelled. The stored
clear-time amount/context (`unit.amount`, `factor`, `servingsAtClear`) becomes
informational — it feeds the legacy wire spelling and describes the clear, but
is never matched against.

**2. Every bucket is scoped by the claim's `keyName`.** The first buckets
keyed by unit/container/raw basis alone, so clearing cornstarch-1-cup hid
flour-1-cup (a regression of the sibling-vanish class this ADR exists to kill,
and a violation of the owner contract). Buckets are now
`keyName||u:<unitKey>` / `keyName||c:<containerKey>` / per-keyName raw sets,
and `lineClaimed` resolves each rendered line's group from the line's own key.
The owner contract is preserved: same-nameKey same-kind claims still aggregate,
so a full merged clear ("4 medium heads" across contributors) sums to the
merged line and hides it, while a partial clear sums short and keeps the line
visible.

**3. Legacy strings migrate to `approx` identity claims — one claim per merged
identity, no invented serving context.** The pre-ADR-0092 string model pushed
the MERGED line key into every contributing variant's array, and it carries no
per-variant share and no serving snapshot. The first migration stamped the
plan's CURRENT servings as the clear context (wrong the moment the plan had
moved since the clear) and minted a full byUnit claim per contributor — N
contributors summed to N × the merged line and the line reappeared. The
migration now stamps `factor: 1, servingsAtClear: 0` ("unknown", never
invented) and `approx: true`. Approx matching has two tiers. Unitless
claims (`egg||`) and raw/row claims match by IDENTITY PRESENCE — the
rendered line whose identity equals the claim's is hidden at any re-sum
(the pre-ADR identity semantics made robust: the identity survives
servings and composition changes, finding 4, and N duplicate legacy
claims never sum, finding 5). Unit-bearing approx claims carry their
advisory amount and OR-match it against the merged re-sum over a Set
(Kody #2: a stale partial clear can never overwrite a whole-line
clear), so a legacy `milk||1cup` no longer hides a `3 cup` merge; on
AMOUNT MISMATCH the line hides only when the identity's approx claims
are COMPLETE — one per contributing variant (the pre-ADR-0092 string
model pushed the merged key to every contributor), so a fully-cleared
identity stays hidden after a serving change rotates the stored amounts
past any match, while a partial clear keeps the line visible (kody
critical). Either way one identity matches at most one rendered line
per group, so no sibling is swallowed.
Raw `approx` claims keep verbatim matching (raw rows pass through unscaled);
a raw row whose key source parsed (the restriction seam) takes its successor
from the shadow's re-summed raw basis, matched by unit identity inside the
group, falling back to verbatim when the group is ambiguous.

**4. Mixed-household wire freshness is decided by DISAGREEMENT, not presence.**
`applyRemote` used to prefer `clearedV2` whenever present. But a peer that
predates `clearedV2` writes only `cleared`, and the relay's per-store
persistence (ADR-0088) treats an absent key as silence — so a legacy peer's
newer push left the older `clearedV2` row persisted, and a joining peer applied
the stale object arrays. Carrying per-store `updated_at` to the client would be
a cross-runtime protocol change; instead the client exploits an emission
invariant: a V2-capable sender derives BOTH spellings from ONE state at
snapshot time, so its two keys always agree. Disagreement between
`clearedSpellingsDiverge(cleared, clearedV2)` therefore PROVES the last writer
predates V2 emission, and the legacy spelling (migrated) is applied. Absent
keys keep the presence-decides contract; agreeing spellings apply `clearedV2`
(the precise shape).
