# ADR-0050: Extra items are sub-sectioned by their own store category

* Extends: ADR-0015 (extras live in EXTRA ITEMS with a category tag),
  ADR-0008 (auto-collapse of grocery categories), ADR-0045 (one shared
  dropdown), ADR-0014 (bulk-add loop)
* **Supersedes, in part:** ADR-0015 §1 (the extras group is a static,
  non-collapsible scratch pad) and the third bullet of ADR-0015's
  "Alternatives considered" ("Make the extras group collapsible like the
  store sections — rejected…")
* Status: **Accepted** (2026-10-04)
* Companions: `src/lib/extraSections.ts` (new, pure),
  `src/components/GroceryTab.vue`, `src/components/IngredientAutocomplete.vue`,
  `e2e/grocery-extras-and-shop.spec.ts`, `e2e/bulk-add.spec.ts`

## Context

ADR-0015 (v0.9.0) made the extras group a deliberately flat thing. Its
own words:

> "Extras live in the EXTRA ITEMS static group. A free-form add is an
> 'Extra' and stays in that group: a plain header, no chevron, no
> collapse, no count-driven reordering."

and, rejecting this feature in writing:

> "**Make the extras group collapsible like the store sections** —
> rejected: it is a small static scratch pad; a chevron there implies a
> body of items that never appears."

The owner has now asked for exactly that, twice:

> "review the drop-down used there to be sure they use our new drop-downs"
> *(then, clarifying: "I mean for the categories drop-down")*, and the
> sub-sectioning ask: extras grouped into their own category sections
> (Produce, Dairy, …) with the same auto-collapse the real store
> sections already have.

**That is a legitimate reversal — the owner owns the decision — so this
ADR exists to record it rather than leave ADR-0015 standing as if it were
still accurate.** ADR-0015's file is untouched: it documents history, and
this ADR is what supersedes it, in the two places below.

### Why the old reasoning no longer holds

ADR-0015 rejected the chevron because "a chevron there implies a body of
items that never appears". That premise was true of the group HEADER: the
extras group is one flat `<ul>` under one static heading, so there is
nothing per-category to open or close. It is **no longer true of the
sub-sections**, because the sub-section body is defined by the category
the user (or the index match) attached to each extra. The store sections
already work exactly that way — a bucket with zero lines never renders —
so a sub-section with items genuinely has a body, and the chevron means
what it says.

The second change that makes this real: `customIngredients` already
remembers a **deliberate** store category per extra (ADR-0012, ADR-0014's
override dropdown), so a category is no longer only a text-derived guess
to be shown in passing — the user can pick one per add, and now wants to
see and act on it.

## Decision

1. **The sub-sections live INSIDE the extras group, and the group header
   stays.** `data-test="extra-section"` remains the single container,
   still FIRST on the Grocery tab, still with the add-row anchored
   directly under its header. The group header itself keeps its static
   shape (no chevron, no toggle) — what gains a toggle is each
   sub-section *below* it. `useGroceryList`'s `sections` computed is
   untouched: it is the derived recipe-driven engine, and extras never
   flow through it.
2. **A category is still a LABEL, never a move — ADR-0015 §2 SURVIVES
   INTACT.** An extra tagged `Produce` lives in the extras group's own
   `Produce` sub-section and MUST NOT appear in the recipe-derived
   `Produce` store section. The sub-section is a *view over the extras*,
   not a route into the store list. (Two e2e specs pin this.)
3. **`Uncategorized` is a real, named, collapsible sub-section (ADR-0015
   §3 is INVERTED).** An extra whose remembered category is missing,
   empty, or the `Other` bucket lands in `Uncategorized` instead of
   rendering as an unlabelled flat row. The owner wants the absence of a
   category *visible* and collapsible rather than silently flat. It sits
   **last**, after every real category, mirroring `STORE_SECTIONS` where
   `Other` is last.
4. **Sub-section order follows `STORE_SECTIONS`.** The canonical constant
   is reused; there is no second hard-coded copy of the category list in
   the component (the DRY failure ADR-0045 §1 calls out, which
   `AutoPlanDialog` already made once with the meal-type taxonomy). Only
   categories that actually have extras render — an empty `Produce`
   sub-section never appears just because `Produce` is in the constant.
5. **Auto-collapse is the SAME rule as the store sections (ADR-0008).**
   One implementation: the same done-map, the same
   false→true / true→false watcher, the same separate `manualCollapsed`
   set. Collapse state is keyed by a **namespaced** key, because extras
   have their own `Produce` sub-section and the store list has a real
   `Produce`: toggling the extras `Produce` must never collapse the store
   `Produce` (or any other pair). The namespace helpers
   (`extraCollapseKey` / `storeCollapseKey`, `src/lib/extraSections.ts`)
   are pure and unit-tested so the collision is structurally impossible
   rather than merely asserted.
6. **Sub-section headers match the store-section affordances.** Same `N/M`
   count pill, same chevron, same `aria-label` shape
   (`<Section>: X of Y checked`), same `aria-expanded`. A sub-section is
   collapsible by header click. The markup is shared with the store
   section header — one visual language, not two.
7. **The per-row category TAG is removed.** Once an extra sits under its
   own category sub-section, a `#Produce` pill on the row repeats the
   heading directly above it. This is a **visible, deliberate change**, not
   a silent one: the accessible information does not regress, because the
   sub-section heading (a real heading inside the group) carries the
   category and the group's structure reads as a labelled list of lists.
8. **The category override `<select>` becomes the shared
   `FilterDropdown`** (ADR-0045), consumed — not forked. `fullWidth: false`
   (a stacked full-width row under the input, the ADR-0046 §2.2
   precedent), options built from `STORE_SECTIONS` with the empty-value
   "Pick a store category" placeholder first so "no override yet" is
   still expressible. The override still resets after every add and a new
   keystroke still invalidates it — that behaviour is load-bearing for
   the ADR-0014 bulk-add loop.
9. **No new persisted slice.** Extras' categories already live in
   `customIngredients`, already registered in `src/lib/backup.ts`
   (`custom-ingredients.json`) and already covered by the registry
   assertion. This ADR adds a *view* over existing data; nothing is
   persisted, so `STORE_SLICES` is unchanged.
10. **Room sync is unchanged (ADR-0012), and the consequence is now
    visible.** `customIngredients` is deliberately device-local and OUT of
    the shared payload. Extras' sub-sections therefore come from the
    *reading device's* memory: a second household member may see the same
    shared extras under different sub-sections, or all under
    `Uncategorized`. This is pre-existing behaviour (the tag showed the
    same asymmetry), but sub-sections make it structural, so it is
    recorded here rather than left for someone to discover.
11. **ShopView is OUT OF SCOPE for auto-collapse (ADR-0008 addendum).**
    ShopView's extras group stays manual-collapse-only; a one-item extra
    must not auto-hide mid-trip. The owner's ask is about the Grocery
    tab's list UX.

## Selectors (data-test)

* `extra-section` — the group container, unchanged (ADR-0015).
* `extra-subsection` — one category sub-section inside the group.
* `extra-subsection-toggle` — its collapsible header button.
* `extra-subsection-rows` — its `<ul>` (mirrors `grocery-section-rows`).
* `extra-row` — the row itself, unchanged.
* `section-count-pill` — the shared `N/M` pill, reused.
* `extra-item-category-tag` — **REMOVED** (decision 7).
* `ingredient-category` — the override trigger, verbatim (ADR-0045 §3).
* `ingredient-category-menu` / `ingredient-category-option-<value>` — new,
  in ADR-0045's naming style.

## Consequences

- The Grocery tab's first child is still the extras group; specs that
  assume the first `[data-test=grocery-section]` is the first group must
  compare against `[data-test=extra-section]` explicitly (unchanged).
- Grouping lives in one pure lib with its own unit spec, not inline in
  the component — the repo derives and unit-tests (`grocery.ts`,
  `useGroceryList.ts`, `containers.ts`); component-local aggregation is
  the pattern this codebase avoids.
- e2e: three `selectOption()` call sites had to be rewritten (the
  dropdown is a `<button>` + popup, not a `<select>`), and the three tag
  assertions were deleted because the tag is deliberately gone. The
  never-routed assertions are unchanged and stay green.
- The `Other` bucket and `Uncategorized` are the same set of rows; only
  the *name* changes (ADR-0015 §3 inverted).

## Alternatives considered

- **Rename `Other` to `Uncategorized` in `STORE_SECTIONS` itself** —
  rejected: `Other` is the ingredient-index fallback bucket
  (`bucketFor`), used by the recipe-derived path and the add toast; only
  the extras *view* gets the friendlier name.
- **Put the extras group after the store sections** (siblings) —
  rejected: ADR-0015's "add bar and the things it creates are one visual
  unit" ordering is unchanged, and the group stays one container
  (`extra-section`) so every existing extra spec keeps its anchor.
- **A second collapse implementation for extras** — rejected (KISS/DRY):
  the brief for a bug-prone duplicate of a 20-line watcher; one done-map
  with namespaced keys is smaller and impossible to diverge.
- **Auto-collapse in ShopView's extras group** — rejected: ADR-0008's
  addendum deliberately keeps it manual-only, and e2e pins it.
- **Merge extras into the real store sections now that they are grouped** —
  rejected: that is the routing ADR-0015 rejected and this ADR explicitly
  does not resurrect.

## Decision log

- 2026-10-04 — chose a superseding ADR over editing ADR-0015: the owner
  reversed one bullet of a historical record, and rewriting history in
  place would lose the reason the reversal happened.
- 2026-10-04 — kept the extras GROUP header static (no chevron) while
  giving sub-sections toggles. The owner's ask was about categories; a
  collapsible group on top of collapsible sub-sections is two clicks to
  see nothing, and the group is one add-bar plus its children.
- 2026-10-04 — removed the per-row tag rather than keeping it "for
  accessibility": the sub-section heading carries the category, and the
  tag would be a duplicate of the line directly above it.
## Addendum — 2026-10-05 (PR #44 review follow-up)

Three decisions taken while landing this ADR, none of which reverse
anything above.

### A1. ShopView sub-sections extras too (same lib, own visual language)

The Grocery tab got the sub-sections, the shopping screen did not: the
owner showed `/shop` with one flat "Extra items" list (egg, eggplants,
celery) above "Produce", which is the pre-ADR-0050 shape. A shopper
scanning a store aisle is exactly the reader who needs the categories.

- **Same `groupExtras`**, same `STORE_SECTIONS` order, same
  Uncategorized-last, same omitted-empty rule. The screen renders its own
  rows and its own chrome, but the GROUPING stays one pure function
  (`src/lib/extraSections.ts`) — a second implementation would drift the
  first time a rule changed, which is the DRY failure this repo's
  coding-philosophy skill names.
- **The extras GROUP header keeps its own single boolean**
  (`extrasGroupCollapsed`) rather than joining the namespaced sets: it is
  a group label, not a section, and it is manual-only like everything
  else extras on that screen.
- **Sub-section headers carry an `N/N` pill and the
  `${name}: ${done} of ${total} checked` accessible name**, matching
  `shop-section-toggle` — consistency inside the screen matters more
  than mirroring the Grocery tab's smaller uppercase type. The outer
  "Extra items" header keeps NO pill, exactly as the owner's screenshot
  shows it: it is a group label whose count would just restate its
  children.
- **Never routed, here too (ADR-0015 §2):** an extras `Produce`
  sub-section is not the recipe-derived `Produce` section below it. Both
  are now named keys in the SAME screen, so `ShopView`'s collapse state
  moved to the namespaced `extraCollapseKey` / `storeCollapseKey` — the
  same structural separation §5 gives the Grocery tab.
- **Auto-collapse is still MANUAL-only on this screen.** ADR-0008's
  addendum keeps it and e2e pins it; this ADR adds grouping only. The
  auto-collapse watcher therefore still walks store sections only, and
  the extras sub-sections are absent from the done-map by construction
  rather than by a special case. (Proposal for the owner, not shipped:
  now that a sub-section is a real group with a done-map of its own, the
  same "done → collapse" rule would be consistent here. It would also
  mean a mis-tap on a one-item extra yanks the list mid-trip, which is
  the exact reason the addendum says no.)

### A2. `removeCustomItem` takes its checked key with it (and the plan store stays clean)

`plan.removeCustomItem` spliced the extra out of `customItems` and left
`custom||<name>` set in the grocery checked map. The stale key predates
this ADR (identical on `b02f8f1`), but auto-collapse turned it into a
visible bug: re-adding a checked extra — or re-adding it under a
different category, so it lands in a fresh sub-section — made the
done-map read false→true and the watcher collapsed the group that had
just been emptied, hiding the row the user had just added.

- The cleanup lives at the **removal site** (`GroceryTab`'s
  `removeExtra`), via a new one-key primitive `checked.forget(key)` on
  the grocery store.
- **Not** inside `plan.removeCustomItem`: the plan store owns
  `customItems` and is synced + backup-registered; the grocery store
  owns the checkbox keys, whose format (`custom||<lowercased name>`) is
  a RENDERER's convention. Importing the grocery store into plan would
  put a view-owned dependency inside the synced store for a key it does
  not understand, and would make every non-Grocery caller (a future
  kitchen-mode list, a room-driven removal) silently responsible for a
  rule they cannot see.
- `forget` is a key-agnostic primitive; it replaces the map immutably so
  the done-map computeds re-evaluate synchronously.

### A3. The add-item combobox's ARIA state follows the listbox

`IngredientAutocomplete`'s suggestion `<ul>` renders only when
`open && !categoryMenuOpen && rows.length > 0`, but `aria-expanded` and
`aria-controls` tested only `open && rows.length > 0`. While the category
popup was open the combobox announced an expanded listbox whose node was
not in the DOM.

- ONE derived value, `suggestionsVisible`, computed from the pure
  `isSuggestionListVisible()` in `src/lib/ingredientSuggestions.ts`,
  drives the `v-if`, `aria-expanded`, `aria-controls` AND
  `aria-activedescendant`. Repeating the expression at four sites is how
  the two halves drifted in the first place; the pure helper makes the
  rule unit-testable.

## Addendum (2026-10-05) — the owner reverses the ShopView manual-only rule; one sink for every group

Phase 3 of this PR. **This is a deliberate reversal of two prior ADRs** —
ADR-0008's addendum (ShopView auto-collapse covers store sections only) and
this ADR's own §A1 bullet ("Auto-collapse is still MANUAL-only on this
screen") — recorded as such rather than as a correction of their reasoning.
The earlier reasoning was right for its moment; the owner's screenshot showed
what it costs once both kinds of group sit on the same screen.

### What changed and why

The owner's `/shop` screenshot showed the extras `Produce 2/2` sub-section —
every row checked — still EXPANDED, directly above the recipe-derived
`Produce 6/6` correctly auto-collapsed. Same screen, two different rules for
groups that look identical and both read `N/N`. The owner reversed the
manual-only rule: **auto-collapse applies in `/shop`, including the extras
sub-sections.** The original concern (a mis-tap on a one-item extra yanks the
list mid-trip) no longer outweighs the consistency requirement: a group that
reads `N/N` while its neighbour is collapsed reads as "not working". One rule
for every group on the shopping screen.

### The single-item judgement call: uniform, no exemption

The original objection was specifically about a ONE-item sub-section: one tap
checks the last row, the group collapses, and the row the user just tapped
disappears. A size exemption ("don't auto-collapse sub-sections with a single
item") would answer it — but an exemption is a SECOND rule, and "consistent"
was the whole point of the reversal. So the shipped rule is uniform: every
extras sub-section auto-collapses on completion, a one-item one included.

Nothing is lost by it: the checked row stays visible in the collapsed header's
`1/1` pill, a manual click on the header re-opens and pins it (the store
sections' exact behaviour), and unchecking re-expands it. The Grocery tab
already behaves this way for one-item groups. If a future owner wants the
exemption, it is a one-line condition in the done-map — proposed, not shipped.

### DRY: the checked-sink is now ONE helper

The store sections' checked-sink lived as an inline `.sort(...)` inside the
store-section `v-for` — knowledge the extras sub-sections needed the moment
they joined the screen's rules. It is extracted to `src/lib/sink.ts`
(`sinkChecked(rows, isChecked)`), pure, stable by construction (a single-pass
partition — not reliance on `Array.prototype.sort`'s engine-guaranteed
stability over a `flatMap`-built copy), unit-tested in `src/lib/sink.test.ts`
(stability, all-checked, none-checked, empty, no-mutation), and rendered
through by BOTH the store sections and the extras sub-sections. The inline
sort is deleted. **The trade, named:** DRY won over KISS — the loser (keeping
the inline sort and adding a second one for extras) would have been two sort
expressions that drift apart the first time the ordering rule changes, which
is exactly the failure mode this repo's coding-philosophy skill warns about.

### The done-map: ONE map, ONE watcher (SOLID kept)

`ShopView`'s `sectionDone` computed now carries BOTH kinds of group under
their namespaced keys (`extraCollapseKey` / `storeCollapseKey`, §5): the
extras sub-sections are entries in the SAME map, fed by the SAME
`flush: 'post'` watcher. ADR-0008's ordering rationale is extended, not
replaced: the watcher still runs AFTER the sink has re-rendered, so a group
hides only once its checked row has already sunk to the bottom — doing it the
other way round would hide the group before the sink order settled. Manual
collapse still wins over auto (clicking an auto-collapsed header re-opens and
pins it), the collapse fires on the false→true transition only, and a
sub-section that mounts already-complete does not collapse on first paint
(the watcher's `prev?.get(name) ?? false` guard means only observed
transitions collapse).

### What was NOT touched

- The outer "Extra items" GROUP header keeps its own single boolean and stays
  manual-collapse-only: it is a group label, not a section (§A1), and it has
  no done-state of its own.
- ADR-0015 §2 (never routed) is untouched: an extras `Produce` is still never
  in the recipe-derived `Produce` section, and the namespaced keys keep the
  two apart.
- ADR-0008 and ADR-0015 are NOT edited; this addendum is the record of the
  reversal. The e2e specs that pinned manual-only behaviour were rewritten to
  pin the uniform rule.

## Addendum (2026-10-05) — the `custom||` checked key is reconciled, not just dropped at one call site

Closes the residue §A2 left open. That addendum fixed the ONE path its author
knew about (a user removing an extra in `GroceryTab`) and correctly noted the
room path as "pre-existing, out of scope". Reading the code rather than the
note showed the diagnosis was **wrong in both directions**.

### The diagnosis was wrong: room sync CONVERGES, it does not leak

`room.applyRemote` does `groomery.map = checked` — a WHOLESALE replace from
the snapshot. After a sync the local map is exactly what the sender held, and
the sender cleaned up at its own removal site. So a peer deleting an extra
converges BOTH devices onto "no key". Room sync was never the leak.

### The real leak: two payload fields with no invariant between them

`customItems` and `checked` travel as **separate fields** — in a room
snapshot, in a backup archive (`plan.json` vs `checked.json`), and in a share
link. Nothing ties them together, so any peer at any app version can hand us a
`custom||<name>` key for an extra that is not in `customItems`. The residue is
invisible but harmful: the orphan key reads as "already done", so re-adding
that name lands in a sub-section the done-map immediately calls COMPLETE, and
§Phase-3's uniform auto-collapse hides the row the user just added. §A2's fix
made the common case safe; it did nothing for a key that arrives from outside.

### The decision: one pure reconciler, called at the boundaries

`src/lib/extraCheckedKeys.ts` owns the knowledge as a PURE function over plain
data:

- `extraCheckedKey(name)` — the ONE definition of the key format. The Grocery
  tab, ShopView and the reconciler now share it instead of each re-spelling
  `` `custom||${name.toLowerCase()}` ``.
- `reconcileCheckedExtras(checked, extras)` — drops every `custom||` key with
  no matching extra, keeps everything else, and reports `changed`.

It is wired at the **boundaries that can create the disagreement**, not at the
one call site that used to leak:

| boundary | why |
| --- | --- |
| `room.applyRemote` | an inbound snapshot is the wholesale replace that can introduce it |
| `backup.ts` `checked.json` writer | an archive carries `plan.json` and `checked.json` as separate slices; `plan.json` is applied first, so the live extras are known |

`reconcileExtras` returns `changed`, so a no-op costs nothing — and in
`applyRemote` specifically it needs **no republish**: the dropped key
described an item the household no longer has, so no peer is missing state
because of it. (ADR-0028's reconciliation is about rows the room LACKS; this
key is not one, and republishing would risk a feedback loop for nothing.)

### Why not a watcher on `customItems` (SOLID)

A watcher would have been shorter, and wrong on two counts: it needs the
grocery store *inside* the plan store — which §A2 explicitly rejected, since
the plan store is room-synced and backup-registered while the `custom||`
format belongs to the renderers — and it would also fire on every unrelated
mutation of the plan. Reconciling at the ingress keeps the plan store free of
a view-owned dependency and confines the work to the two moments the two
facts can actually diverge.

**The trade, named:** DRY over KISS — the loser would have been a
`custom||`-prefix test re-spelled at each future ingress point, drifting the
first time the key format or the "what is an orphan" rule changed.

### Not touched

- `GroceryTab.removeExtra`'s explicit `checked.forget(...)` stays: it is the
  *immediate* local path (no snapshot round-trip), and it is what makes the
  removal feel instant. The reconciler is the backstop for keys that arrive
  from outside, not a replacement.
- `plan.clearCustomItems()` needs no wiring — `useConfirm.performClear` calls
  `grocery.clearAll()` in the same breath, so that path is already whole.

### Review follow-up: the third ingress point, and why the prefix changed

Two findings from the round-2 bot review of this fix, both real, both acted on.

**1. `?p=` share links were a missed ingress point.** kody-ai (high) caught it:
`App.vue`'s `importSharedPlan` calls `plan.replacePlan(shared.entries,
shared.custom)` — which replaces `customItems` while leaving `grocery.map`
untouched. A link carries no checked state, so any locally checked
`custom||<name>` for an extra the link does not list became exactly the
residue this addendum exists to remove. `reconcileExtras` is now called there
too, making the ingress set what the docs claimed: a room snapshot, a backup
archive, and a share link.

**2. The `custom||` prefix was ambiguous with a grocery LINE key — so it
changed to `extra::`.** Recipe-derived line keys are
`` `${nameKey}||${display}` `` (`src/lib/grocery.ts`), so `custom||` is not a
namespace of its own: an ingredient normalizing to exactly `custom` yields a
line key of the very same shape, and the reconciler would have deleted a real
grocery line's checked state (kody-ai, medium).

No catalog ingredient normalizes to `custom` today — verified across all 2,759
recipe docs / 349 distinct names, and the ingredient index has no such entry —
so this was latent, not live. It is fixed anyway: the catalog is DATA, and a
latent trap that only stays closed while the data stays frozen is not a
guarantee. `::` cannot occur in a `nameKey`, so with `extra::` the two key
spaces are disjoint BY CONSTRUCTION rather than by coincidence.

Because the prefix change would strand every household's existing checked
extras, `reconcileCheckedExtras` also RECOGNISES the legacy form and migrates a
live `custom||<name>` to `extra::<name>` in place. An upgrade therefore keeps
every check the user had.

**The one legacy ambiguity, and the direction it resolves.** A legacy key whose
segment matches no live extra is KEPT, not dropped: `custom||6 medium carrots`
is indistinguishable from an extra named `6 medium carrots`, and structure
alone cannot decide it. Ground truth is the live extras list — no match means
it is far more likely a line key, so it survives. The deliberate cost: an
orphan under the LEGACY prefix is not garbage-collected (an orphan under
`extra::` is). That is the right way round — dropping a live grocery line is
silent and breaks shopping mid-trip, while a retained extra check is visible
and clears the moment the user unchecks it.

### Three key-format copies became one

The format was re-spelled in `GroceryTab`, in `ShopView` (commented as
"mirrors the Grocery tab's") and inline in `useGroceryList`. All three now
import `extraCheckedKey`. That duplication is what made finding 2 possible to
miss in the first place, and it is the DRY loss this repo's coding-philosophy
skill names: a second copy of one fact is where the two spaces drifted.

### The migration also has to run on a plain RELOAD (found in review, and it was a data-loss bug)

kody-ai (high) caught the gap this prefix change opened, and it is the most
serious finding in this PR's review history: the three ingress points only
cover state arriving from **outside**. A plain reload is not one of them.

After upgrade, `mealime-planner:v1:checked` hydrates `custom||<name>` keys
while `GroceryTab`, `ShopView` and `useGroceryList` all read
`extraCheckedKey(name)` = `extra::<name>`. Nothing reconciles them, so
**every already-checked extra renders unchecked** — silent, on the very screen
the user is shopping from, and indistinguishable from "my list forgot". The
reconciler's migration was real but insufficient: it protected the wire and
the archive, not the user's own storage.

Fixed in the store's `persist.afterHydrate`, which is where this repo already
puts every other persisted-blob migration (`ui.ts`: `migrateLegacyFilters`,
`adoptHistoryShareDefault`, `repairDefaultServings`, `repairUnitSystem`).

Two details that are load-bearing rather than incidental:

- **It is handed the LIVE extras.** `reconcileCheckedExtras` re-keys a legacy
  key only when its segment matches a real extra — that is precisely how it
  avoids mistaking a line key for an extras key. Reconciling against an empty
  list (the obvious first attempt) therefore migrates **nothing** and the bug
  ships anyway, silently. The plan store persists in its own slice and hydrates
  independently, so the extras are read lazily rather than assuming an order.
- **It short-circuits when no legacy key is present**, so the common path
  costs one `Object.keys` scan and no store write; the hook is idempotent.

Three unit cases pin it: the persisted-blob reload keeps every check and keeps
its line keys, a second run changes nothing, and an ambiguous legacy key (a
possible line key) is still left alone.
