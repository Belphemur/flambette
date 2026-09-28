# ADR-0014: Bulk add flow — persistent input with immediate-add loop

**Status:** Accepted (2026-09-27)
**Supersedes:** the per-add pick-then-submit interaction of ADR-0012
(the suggestion source ranks and the device-local custom memory are
unchanged and still governed by ADR-0012).

## Context

The grocery add flow (ADR-0012) had one suggestion row per keystroke
ranked from the baked ingredient index, but picking a suggestion only
*filled the form* — the user then had to press Add to commit. Adding N
items meant N × (type, pick, confirm), with the category dropdown as a
separate confirmation step. The user asked for a Bring-style flow:
"easily add multiple items in one go and see what category they are,
and easily add new ones that aren't on the list."

## Decision

1. **Persistent typed-text + row.** While typing (≥ 2 chars), the FIRST
   suggestion is always the typed text itself with a "+" affix. Picking
   it — by click or by Enter with nothing highlighted — commits the item
   IMMEDIATELY, then clears the input and keeps it focused. A run of
   adds is ~2 taps per item ("banana" → +; "milk 2%" → +; …) and the
   flow never closes itself; closing happens only via explicit Done
   (the flow is an always-present form, so "closing" = emptying the
   input — second Escape) or navigation.
2. **Live category feedback on every row.** Each suggestion row carries
   a store-category chip: index match category from the baked index,
   remembered category for a "mine" row, and `Other` for unknown typed
   text. The category is visible BEFORE the commit. The typed + row
   adopts the exact-match category when the typed text nameKey-matches
   an index or remembered entry (and the duplicate ranked row is folded
   away), so the chip never lies.
3. **Toast per add.** Every *new* item confirms with an
   `Added to <Category>` toast (`ui.showToast`, kind `added`, rendered
   as `data-test="added-toast"`). Re-adding an item already on the list
   is a category *correction* for the device-local memory — the item
   isn't new, so no toast fires.
4. **One action behind every surface.** `useAddGroceryItem`
   (src/lib/useAddGroceryItem.ts) is the single add action: plan-store
   add, custom-ingredient remember, toast. IngredientAutocomplete is the
   only UI for it; GroceryTab (empty-state + main) and ShopView embed
   one instance each and carry no add logic of their own.
5. **Keyboard.** ArrowDown/ArrowUp move the highlight (row 0 = the +
   row); Enter adds the highlighted row, or the raw typed text when
   nothing is highlighted; Escape collapses the dropdown (again clears
   the input). The loop never self-closes while the user is bulk-adding.

## Consequences

- The category `<select>` remains as an explicit per-add override; it
  wins over the row's category, resets on every keystroke/add.
- GroceryTab keeps a `defineExpose({ focus })` handoff: the first add
  swaps the empty-state compact form for the main form, and the freshly
  mounted instance takes the keyboard so the loop continues seamlessly.
- Existing data-test ids keep working (`add-bar-input` on the input,
  `ingredient-suggestions` on the listbox); new ids: `add-suggestion-first`
  (typed + row), `add-suggestion-row` (ranked rows), `suggestion-category`
  (live chip), `added-toast` (toast). The old `ingredient-input`,
  `ingredient-submit`, `ingredient-suggestion`, `mine-badge`,
  `ingredient-category` ids behave as before where still rendered.
- Toast copy convention: `Added to <Category>` — category text verbatim
  from `STORE_SECTIONS` (no articles, no quantity, no item name; the
  item is on the list right under the toast).

## Verification

- `bun run build` exit 0.
- e2e: `grocery-autocomplete.spec.ts` (updated semantics) and
  `bulk-add.spec.ts` (three-add loop, remembered category, keyboard
  flow, room-synced mine rows) green on both projects.
