# Conventions (do not break)

Cross-cutting rules for any change in this repo. Each rule names its ADR;
`docs/design/index.md` is the generated index of all decision records.

- **Test selectors**: components use `data-test="..."`; Playwright config
  sets `testIdAttribute: 'data-test'` (NOT `data-testid`).
- **Grocery list is derived**: from `plan.plan` + `plan.customItems` via
  `src/lib/useGroceryList.ts` / `grocery.ts`. Never duplicate aggregation
  logic in a view. Names merge by singularized key (`nameKey`), units by
  `unitKey` (`2 cloves` + `1 clove` → `3 cloves`).
- **Container units are purchased, not divided (ADR-0017)**: line items
  phrased in purchasable containers (`½ (142 g) pkg`, `1 small bunch`,
  `1 head`) are parsed by `src/lib/containers.ts` and CEIL-merged per
  (container, annotation) — never linearly scaled (spoon/measure units
  keep ADR-0009's linear rule). One meal at its own servings keeps the
  authored text; merges render whole (`1 (142 g) pkg`) or fractional
  (`1 1/2 small bunches`). Grocery display is the only thing that
  changes: recipe/cooking step text stays authentic.
- **Diet chips (ADR-0018)**: `src/lib/dietFilter.ts` is a keyword
  heuristic over `variant_meta.ingredient_names` (the catalog has NO
  diet metadata), token-boundary matched and memoized per variant id.
  Treat its verdicts as a suggestion lens, never a guarantee; the
  keyword tables are the tunable part.
- **Quick filters (ADR-0027/0028)**: the WHOLE Recipes-tab filter
  surface is ONE object, `QuickFilters` in `src/lib/quickFilters.ts`
  (`diets`, `protein`, `maxTime`, `sortBy`, `favOnly`, `proOnly`),
  persisted in the existing `mealime-planner:v1:ui` slice. There is no
  "All diets" dropdown and no per-control local ref — the protein slice
  it used to own is a chip (`data-test="protein-chip-*"`), and the diet
  chips keep `data-test="diet-chip-*"` under `data-test="quick-filters"`.
  Every inbound value (backup, room payload) goes through
  `normalizeQuickFilters`, which drops unknown diet ids and defaults
  out-of-range members. The search box is deliberately NOT in the object
  (a search is a question, not a household preference). The control row
  is a 2-column grid on phones so no control can be orphaned on its own
  line (WS1) — keep it a grid, don't reintroduce `ml-auto`.
- **Icons (ADR-0029)**: the icon stack is `@lucide/vue` (the renamed
  `lucide-vue-next`), imported
  per component and BUNDLED (no CDN, no icon font — a runtime icon
  fetch fails e2e by design). No glyph characters (`✕ ★ − ✓ ▸ 🛒 …`) and
  no hand-rolled `<svg>` in `src/`; the one exception is the 1×1 recipe
  placeholder data URL in `src/lib/images.ts`. Decorative icons are
  `aria-hidden`; an icon that carries state must also be queryable
  (`aria-label` / `aria-expanded`), because that is what the specs
  assert. ICON COLOUR is a semantic decision, not a style choice
  (ADR-0036): render a role through `<HueIcon role="…">`, which pulls
  glyph, accessible name and class from the single registry in
  `src/lib/palette.ts` — categorical hues for ingredient TYPE
  (`meat`/`hue-meat`, `fish`/`hue-fish`, `vegetarian`/`hue-vegetarian`,
  `vegan`/`hue-vegan`; the two greens have DIFFERENT tokens AND glyphs)
  and semantic hues for NUTRITION (`energy`/`nutrition-energy` on the
  flame, `sodium`/`nutrition-sodium` on the droplet). A hue is the
  icon's IDENTITY, never its state: selected chips are a TINT
  (`primary-tint` + `primary-strong` text, not a filled tomato), so an
  icon keeps its food hue in BOTH states and stays ≥4.5:1 on the tint;
  the only filled-primary element is the Start cooking action. The two
  families never mix, and colour is never the only signal (the label
  stays).
- **One role registry (`src/lib/palette.ts`)**: every food/nutrition icon
  takes its glyph, accessible name and colour from `ICON_ROLES` /
  `ROLE_GLYPHS`; no component keeps its own icon→hue map. Vegetarian and
  vegan are SEPARATE roles (different tokens AND different glyphs) so the
  pair reads apart in monochrome; exclusion diets (`no-pork`, `no-meat`,
  `no-shellfish`) borrow the protein role but keep their explicit wording.
  A role's class name is a literal string in source, because Tailwind scans
  for complete class names.
- **Design tokens (DESIGN.md, ADR-0036)**: `DESIGN.md` at the repo root
  is the SINGLE SOURCE OF TRUTH for the visual identity (palette,
  typography, shapes, spacing, components + the prose Overview/Do's &
  Don'ts). Its YAML front-matter is compiled into the `@theme` block of
  `src/style.css`, which is why components consume `bg-brand`,
  `text-hue-fish`, `max-w-app`, … and NEVER a raw hex literal. Add a
  colour to `DESIGN.md` first, mirror it into `@theme`, and verify it on
  BOTH surfaces (light + dark) — `src/lib/palette.test.ts` fails when the
  two files drift. Validate the file itself with
  `npx -y @google/design.md lint DESIGN.md`; its WCAG contrast findings
  must be fixed, not waived. `DESIGN.tokens.json` is the generated DTCG
  export (`npx -y @google/design.md@0.4.0 export --format dtcg
  DESIGN.md`) and is refreshed with the token, never hand-edited.
- **Dark mode is a THEME FLIP, not `dark:` pairs (ADR-0036)**: the `.dark`
  block in `src/style.css` re-points each `--color-*` variable at its dark
  counterpart (surfaces, text, borders, `hue-*` → `*-soft`, `brand-text` →
  `brand-soft`). Write `bg-surface-raised` and it is correct in both
  themes; a component must NOT add a `dark:` utility for a colour the flip
  already covers. The only places a literal dark token belongs are the two
  documented design decisions (the selected-chip tint and the dark action
  text). A new token pair goes in DESIGN.md, `@theme`, AND the `.dark`
  block, with a parity test. The `dark` class on `<html>` is set by
  `useDark` from `@vueuse/core` (system preference default, manual
  override persisted); components stay theme-agnostic.
- **Layout width**: the app shell, header, nav, ShopView and Plan sheets
  are `max-w-app` (fluid, capped at 1100px); cooking keeps the 672px
  `max-w-reading` measure. The recipe grid steps 1/2/3/4 columns at
  <360/360/720/1024 — there is deliberately NO five-column stage. Desktop
  richness is ALWAYS `lg:`/`xl:`-gated — mobile padding, tap targets and
  ADR-0016's 82px/tab fit never change to serve a desktop. The immersive
  cooking view keeps `max-w-reading` (672px) on purpose: a step read at
  arm's length wants a measure, not a page.
- **Nutrition**: `meta.calories`/`sodium_mg` are PER-SERVING — never scale
  them by servings; only totals scale.
- **Toasts are STATUS-only** (ADR-0084): `ui.showToast(message, {
  actions, duration, onDismiss })`. `onDismiss` fires exactly once on
  every end path (timeout, replacement, dismiss) — anything guarded
  around a toast must reset via `onDismiss`. CONFIRMATIONS are modals:
  they go through the ONE `confirmModal` funnel (`useConfirm.ts`,
  rendered by the single `ConfirmModal` host in App.vue on AppModal
  machinery, hooks `confirm-modal`/`confirm-action`/`confirm-cancel`)
  — never `window.confirm()`, never a bespoke dialog, never a toast.
  A modal waits for an answer: no auto-dismiss.
- **Accessibility**: every interactive element gets an `aria-label`; every
  view must work in dark mode.
- **Clickable affordance**: every clickable surface gets a pointer cursor,
  and it is DESKTOP-ONLY — `src/style.css` wraps the whole rule in
  `@media (hover: hover)` (a pointer is a mouse affordance; on touch the
  affordance is the tap target, and no `cursor: pointer` may ship to a
  phone). The global rule covers `<button>`, `[role=button|checkbox|
  radio|switch|option]`, `[aria-pressed]`, checkboxes/radios, `<select>`,
  and `label[for]` / labels wrapping a checkbox, so new controls need no
  class. Non-semantic surfaces (a card `<article>`, a row `<img>`/`<div>`)
  use the `hovercap:cursor-pointer` utility, which resolves to the same
  media query. Deliberately excluded: full-screen dialog scrims
  (`@click.self`), which are not an affordance; a disabled control gets
  `not-allowed` and is excluded from the pointer selectors; the grocery
  provenance pill stays `cursor-help` (a tooltip target). Change `cursor`
  ONLY — never a tap target, hit area or padding (ADR-0016's Pixel 7 fit is
  e2e-pinned).
- **Design ADRs**: `docs/design/` holds ADR-style decision records, one
  file per decision. **[`docs/design/index.md`](docs/design/index.md) is the
  index** — generated by `scripts/build_adr_index.py`, and the only place
  that lists them. Read it, then skim the records your change touches; they
  encode *why* the architecture is shaped the way it is (offline catalog,
  derived grocery, per-serving nutrition, clear = remove, rooms, Bun). To
  add one, run `python3 scripts/build_adr_index.py --next` for the number
  (never count files — that is how four numbers got used twice), write
  `ADR-NNNN-slug.md`, then `bun run data:adr-index`. A superseding decision
  is a NEW record that flips the old one's Status; never rewrite an accepted
  one in place.
