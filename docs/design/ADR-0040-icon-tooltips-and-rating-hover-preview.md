# ADR-0040: Desktop tooltips on food icons and hover-preview star rating

**Status:** Proposed (2026-10-01)
**Extends:** [ADR-0036]/DESIGN.md ("Cards and icon labels" — an optional
category tooltip on hover/focus, never a separate action), ADR-0029
(Lucide stack, accessible names), ADR-0031 (household ratings — store
model), ADR-0018 (diet chips).

## Context

DESIGN.md's Components section already prescribes: "Provide an optional
category tooltip on hover/keyboard focus without turning the icon into a
separate action" — the hover tooltip on the food-type icons (meat/fish/
vegetarian/vegan in browse cards and the detail header) is designed but
NOT implemented: `HueIcon` renders `role="img"` + `aria-label` + native
`title`, which gives a browser-native tooltip only on some platforms,
with zero visual control and no keyboard-focus tooltip parity.

Two more gaps:

1. **Rating has no hover preview.** `RatingStars.vue` fills on TAP
   only; hovering a star shows nothing until clicked. The owner wants:
   hover fills up to the hovered slot (preview) and a tooltip showing
   the score that would be set ("Rate 3.5 of 5 stars", which the
   aria-label already carries).
2. Desktop is a first-class surface (ADR-0036): tooltips and hover
   previews are mouse affordances — exactly the class of affordance the
   `@media (hover: hover)` discipline in `src/style.css` already scopes.

## Decision

### 1. One tooltip component, hover-only, used by both features

A small `IconTooltip.vue` (or equal) implements the proven
grocery-tab pattern (`GroceryTab.vue` provenance pill): a positioned
`surface-dark` bubble, shown on `group-hover` AND `group-focus-within`,
`pointer-events-none`, `z-20`, desktop-only — the reveal ruled by the
existing `@media (hover: hover)` gate at the component level
(`hidden hover-cap:block` style utilities or the same wrapper query),
so no tooltip can ship stuck-open on touch. The tooltip is a visual
DUAL of the element's accessible name — it never becomes the only
carrier of the name (ADR-0029: accessible names stay on the element).

**Implementation note (2026-10-01, factual).** The `hidden … hovercap:block`
shape sketched here is emitted by Tailwind v4 as `display:block` INSIDE
`@media (hover: hover)` and nothing else, so on every hover-capable
device it beats `hidden` and the bubble is permanently open — the
opposite of the intent. The shipped reveal is
`hidden group-hover/htt:block hovercap:group-focus-within/htt:block`:
hover reveals everywhere (a touch device cannot fire it) and focus
reveals only on hover-capable devices, which is what keeps a phone TAP
— which focuses the half-slot button — from popping a bubble. Same
"cannot ship stuck-open on touch" guarantee, no failure mode. The
decision (one implementation, hover-gated, decorative duplicate of the
name) is unchanged.

The bubble is rendered by `HueIcon` itself rather than a new
`IconTooltip.vue`: a separate component would need the same wrapper
`group`, the same bubble classes and a slot, to sit inside an element it
does not own. `HueIcon` is therefore the one tooltip implementation.

### 2. Food-type icon tooltips (browse cards + detail header)

`HueIcon` gains a `tooltip?: string` prop. Call-site opt-in is NOT
required: when `tooltip` is omitted, a non-empty `label` becomes the
tooltip, so exactly the two BARE icons that carry meaning on their own
(browse card type icon, detail header type icon) get a bubble and a
labelled control does not. Pass `tooltip=""` to suppress the bubble
while keeping the accessible name. The icon keeps
`role="img"`/`aria-label` (required), and the tooltip is a decorative
duplicate of the label, hidden from AT (`aria-hidden="true"`).
Where the icon sits against the app edge (browse cards top row), the
tooltip flips to below per the grocery pill's behavior pattern; the
implementation reuses one positioning rule, not two.

The keyboard path needs an explicit target: the bare type icons are
not inside a button or a link (the card's stretched link is a sibling
overlay), so `HueIcon`'s host span is `tabindex="0"` (with a
`focus-visible` ring) and `pointer-events-none` — the latter keeps the
stretched link's click path, which the positioned tooltip host would
otherwise cover. Both reveal variants are gated by `hovercap:`.

Diet-chip and protein-chip icons are NOT given tooltips: their buttons
already carry visible text labels (DESIGN.md "Filter buttons KEEP
their visible labels"), and a hover tooltip over a labelled control
is noise.

### 3. Star hover preview (set + tooltip), tap unchanged

`RatingStars.vue` gains hover state (`hovercap:` gating at the
component level):

- **Hovering slot `n`**: preview-fill all stars ≤ `n` using the same
  clipped-overlay `fillPercent` logic — the preview is a RE-RENDER of
  the existing fill, so a half-slot shows a half star preview, exactly
  like a committed 3.5 rating looks.
- **A tooltip follows the hover** showing the score that would be
  set: `Rate 3.5 of 5 stars` (identical text to the slot's
  `aria-label`, so the visible preview and the AT name never drift).
- **Mouse-out** reverts to the committed rating instantly. The
  preview NEVER calls `setRating` and never touches the ratings
  store — the store write stays exactly where it is (tap).
- **Tap/keyboard flow unchanged**: the half-slot buttons stay in the
  a11y tree; `focus()` on a slot applies the same preview fill
  (keyboard focus maps to the hover contract via `group-focus-within`
  so focus-visible users get the same signal).
- **Cursor**: the star zone is a real control (`<button>`), so the
  global `@media (hover: hover)` pointer rule from `style.css` already
  gives the pointer cursor — nothing new there.

The existing `data-rating`/`data-variant-id`/`data-test="rating-star`
hooks and aria-labels are untouched; the e2e rating specs keep passing
with zero behavioral difference on tap.

### 4. No store/lib changes, no new deps

Both features are presentation-only at the component layer — no new
Pinia state, no persisted slice, no ADR-0013 registry work, no new
runtime deps.

## Alternatives considered

- **Use a headless tooltip lib (Floating UI, Headless UI).** Rejected:
  one positioning rule inside the existing hover-cap media query covers
  both features (the grocery pill has shipped the same pattern for
  months with zero drift complaints); a float-engine dependency for two
  call sites is complexity without a job (KISS after DRY is satisfied —
  the pattern exists once in the codebase already).
- **CSS `title` attribute only.** Rejected: unstyled, timing-inconsistent,
  and not keyboard-focusable — fails the desktop-richness ask.
- **Preview by filling whole stars only (no half preview).** Rejected:
  the store is a 0.5-step grid (ADR-0031); a preview that can only
  show integers misrepresents the half-slot target it sits over.
- **Tooltip on the diet/protein chips too.** Rejected per §2 —
  labelled controls; tooltip duplication.

## Consequences

- `HueIcon` grows one optional prop; two call sites opt in.
- `RatingStars` gains hover state (a `ref` + orientation, no store
  touch); the committed-rating fill code is REUSED for the preview
  (one `fillPercent`, two states feeding it: committed vs hovered).
- Tooltips and preview fills are unreachable on touch — by the same
  media-query discipline that scopes the pointer cursor (the tap
  targets are unchanged, so ADR-0016's Pixel 7 tab fit is untouched).
- The aria-labels on the slots remain the truth; the sighted hover
  preview and the AT names render from the SAME string table. AT users
  get an equivalent feature by keyboard focus (proven grocery-pill
  pattern already e2e-tested with `focus()`).
