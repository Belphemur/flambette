# ADR-0045 — one shared dropdown component for every Recipes filter

* Extends: ADR-0043 (meal-type dropdown), ADR-0027/0028 (unified quick
  filters), ADR-0036 (DESIGN.md "Selection and actions")
* Status: **Proposed** (2026-10-02)
* Companions: `src/components/FilterDropdown.vue` (new),
  `src/composables/useListboxMenu.ts` (existing, extracted by ADR-0043),
  `src/components/RecipesTab.vue`, `e2e/quick-filters.spec.ts`,
  `e2e/meal-type-filter.spec.ts`

## Context

Owner report, verbatim: *"cook time dropdown should have the same style as
the other dropdown, we should have a clean dropdown component."*

The Recipes filter bar currently speaks **three** visual languages for what
is conceptually one control:

| Control | Mechanism | Look |
| --- | --- | --- |
| Cook time | native `<select>` (`data-test="cook-time-filter"`) | OS-rendered popup, platform-dependent |
| Sort | custom `role="listbox"` popup | app-styled bubble + `Check` |
| Meal type | custom `role="listbox"` popup (ADR-0043) | app-styled bubble + `Check` |

The native `<select>` is the odd one out: its popup is drawn by the OS, so on
a Pixel 7 it opens a platform sheet that shares no styling with the other
two, and it cannot carry the per-option counts or icons the other two show.
The owner sees three dropdowns; two match and one does not.

This is a **DRY** failure in the shape the coding-philosophy skill calls out:
pi's ADR-0043 already extracted the ~70 lines of focus bookkeeping into
`useListboxMenu` (arrows, Home/End, Escape + refocus, Tab, click-away), which
was the right call. But it extracted the *behaviour* and left the *markup*
duplicated — and the markup is where the visual inconsistency lives. Three
trigger buttons with three class strings, three popup shells with three
widths, and a fourth control that opted out of the system entirely.

## Decision

### 1. One `FilterDropdown.vue` owns trigger + popup shell

A single component renders the whole affordance: the `h-11` trigger
(icon slot + label slot + chevron), the `role="listbox"` popup, the option
row with its `Check`-or-spacer alignment, and the open/close wiring on top
of `useListboxMenu`. All three controls use it.

Options are passed as data (`{ value, label, ariaLabel?, icon? }`), not as
markup, so the component can compute the selected index and the `Any` row
without the parent re-deriving them. This is the DRY point: the trigger
classes, the popup shell, the `w-4` spacer that stops the labels shifting
when the check appears, and the `aria-selected` wiring exist **once**.

Slots are used only where the three genuinely differ — the leading icon
(clock vs `ArrowUpDown` vs `HueIcon`) — so the difference is expressed
without forking the shell.

### 2. The native `<select>` is deleted, not restyled

Cook time becomes a `FilterDropdown` with options `Any / ≤20 / ≤30 / ≤45`.
Per KISS (deletion over re-architecture) there is no attempt to keep the
`<select>` as a fallback — the custom popup already satisfies every
requirement the select met, plus keyboard parity the native control never
had on this surface.

`quickFilters.maxTime` keeps its exact type (`number | null`) and
`normalizeQuickFilters` semantics: **no store, backup, room-payload or
migration change**. This is a presentation change only.

### 3. The `data-test` contract is preserved verbatim

`cook-time-filter`, `sort-button`, `sort-menu`, `sort-option-<value>`,
`mealtype-button`, `mealtype-menu`, `mealtype-option-<label>` all keep their
exact current values and meanings, passed in as props. A refactor that
renames the selectors is a refactor that also has to edit every spec, which
buys nothing.

### 4. Trigger sizing stays inside the WS1 grid

ADR-0027's WS1 (no control orphaned on a line of its own on a phone) is
e2e-pinned by a selector list that includes `[data-test=cook-time-filter]`.
Converting the select to a button must not change that control's grid
footprint: the dropdown root takes `w-full` in the 2-column phone grid and
`sm:w-auto` above it, exactly as the meal-type trigger already does.

## Consequences

- All three dropdowns are pixel-identical in trigger and popup, and the cook
  time popup finally shows on a phone in the app's own style.
- `useListboxMenu` gains its third consumer, which is what makes it a real
  shared component rather than an extraction that only ever had two callers.
- The popup is a `<ul role="listbox">` of `<button role="option">` rows, so
  the accessible name, `aria-expanded`, `aria-selected` and the roving
  `tabindex` are identical across all three — one behaviour to test.
- Trade-off recorded: a custom popup is more code than a native `<select>`.
  That cost was already being paid twice; this ADR pays it once. On mobile
  the popup is an in-page list rather than the OS picker sheet — accepted,
  because consistency with the other two controls is what was asked for, and
  the native sheet's advantage (OS-level input) is not one this filter needs
  (it is a short, fixed 4-item list).

## Decision log

- 2026-10-02 — chose one `FilterDropdown` component over a styled wrapper
  around the native `<select>`. The wrapper would have kept two popup
  mechanisms alive forever (SOLID-looking abstraction that duplicates
  behaviour = the exact anti-pattern the coding-philosophy skill names), and
  would still not have given cook time the icons and counts the other two
  show.