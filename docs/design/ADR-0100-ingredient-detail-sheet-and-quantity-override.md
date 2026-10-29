# ADR-0100: Ingredient detail sheet + per-line quantity override

Status: accepted — design adopted 2026-10-28 (owner reviewed the Stitch renders; "The mockup looks awesome, this is what I want"). Data corpus: ADR-0099. Implementation pending.

Change note (2026-10-28, post-adoption verification): the desktop modal
citation below originally read `9846068c4e4e462c8f8f7feb0d3a1598` — a
PHANTOM id (that generation never landed; `list_screens` proves it absent
from the project). The desktop form was re-generated as
`1142b9332ed84a90b4bfe3fe70985034` and its exported HTML verified (fonts:
Plus Jakarta Sans + JetBrains Mono only; every hex inside the Warm Culinary
Paper set). Never trust a remembered screen id — verify against the project.

## Context

Issue #101 asks for an ingredient detail view in the grocery list: image
preview, substitutes, and the planned recipes using it. ADR-0099 built the
data corpus (fused `ingredient_detail.json`, 601 images / 338 substitute
rows). This record fixes the UI.

Mid-design the owner added a second requirement: easy quantity editing on the
grocery list that does not conflict with the tap-to-open sheet. The grocery
quantity badge is a DERIVED projection (summed across contributing meals,
container ceil-merge ADR-0017, seasoning scaling ADR-0009, cleared-claim
filter ADR-0094) — there is no per-line stored quantity to edit, so the edit
must be an OVERRIDE owned by the grocery line, not a plan-servings edit.

## Design authority (Stitch renders)

The adopted visual authority is the Stitch render **"Flambette — Ingredient
Detail: Peaches (Bottom Sheet)"** (project 2725470430841257407, screen
`3911e1af46314353b8b8818d8ab767c7`), verified against its exported HTML:
fonts are exactly Plus Jakarta Sans + JetBrains Mono; every hex maps to the
Warm Culinary Paper token set. Supporting explorations (same project):

- "Grocery List (Editable Quantity)" — mobile `7245589bb91e457daa778ecefc631771`
  and desktop `d8ac47441a5c413c8f3145e7ae98f582`: the editable-quantity badge
  affordance (dashed underline + pencil glyph; open state shows an inline
  stepper pill with Reset).
- "Ingredient Detail: Peaches (Desktop Modal)" — `1142b9332ed84a90b4bfe3fe70985034`:
  the desktop form is a centered ~480px modal on the Level-3 espresso-blur
  backdrop (same content as the mobile sheet).

The owner pasted the two grocery renders as export directories
(`stitch_flambette_recipe_app_grocery-edit-{mobile,desktop}`, each with
`code.html` + `screen.png` + a Warm Culinary Paper token file). The exports
carry NO ids internally — the ids above are the `list_screens`-verified
truth, and the pasted `code.html` is the adoption contract for structure,
classes and copy.

Two LAYOUT variants of the sheet were generated after adoption was declared
and are NOT adopted — the base layout is the contract.

## Decision — ingredient detail sheet

- **Bottom sheet on the AppModal machinery** (teleport, focus trap,
  Escape/scrim, z-50) — the same overlay rung as ConfirmModal/ADR-0084. On
  desktop (lg+) the same content renders as a centered modal card (~480px) on
  the espresso-blur backdrop. No route, no SEO surface (not indexable; the
  SPA fallback canonical stays `/`).
- **Trigger (owner ruling):** tapping the ingredient NAME + amount area opens
  the sheet on BOTH GroceryTab and ShopView; the checkbox still toggles.
  Sheet state is an ephemeral ui-store prompt slot `{ nameKey, displayName }`
  — not persisted, not room-synced.
- **Sheet structure** (per the adopted render): grab handle → title row
  (display name + aggregated amounts in the mono data voice + close X) →
  full-width height-capped photo band with the credit line **"Photo:
  TheMealDB"** directly under it (owner directive: credit INSIDE the
  ingredient page) → "Need a substitute?" section as ONE prose line →
  "You'll use this in…" recipe rows (circular thumbnail + name + chevron;
  tap navigates to `/recipe/:id` and closes the sheet) → tonal Done button.
- **Substitutes are PROSE, informational** (owner ruling) — never chips, and
  tapping a substitute does NOT re-key or swap grocery lines (ADR-0094's
  checked-key invariants stay untouched). The section hides when the table
  has no row; the photo band is replaced by the aisle glyph + hue (ADR-0076
  `aisleIcon`) when no image exists (270/871 rows) and the credit line hides
  with it.
- **Amounts show in the sheet header** (owner ruling) — the same merged
  amounts the row's badge renders (`entry.line.text`), mono data voice.
- **Plan lookup is derived at open time** from the plan store + catalog docs
  (nameKey match over the plan's recipes) — cheap, offline, no new store.
- **What it deliberately is NOT:** no checking/unchecking from the sheet, no
  household sync of the sheet state, no favourites, no invented metadata
  (the desktop render's "In Peak Season" pill is a REJECTED fiction — no
  seasonality data exists).

## Decision — per-line quantity override (owner ruling, 2026-10-28)

- **The override belongs to the grocery line, keyed by the line's
  composition-stable identity** — `lineKeyIdentity` (nameKey + unit
  identity, the PR #94 round-2 helper), NOT the raw checkbox key (whose
  basis re-spells on composition change). The owner framed it as "each line
  gets a kind of uuid, overridable": a meal removed but the line persisting
  (other contributors) KEEPS the override; the ingredient leaving the list
  entirely removes the line and orphans the override (swept on render — the
  override map never outlives its line).
- **An overridden line renders the override INSTEAD of the derived sum** for
  that line identity; other lines of the same ingredient (different unit
  identity) are untouched. The override amount is authored in the line's own
  unit grammar (g/ml/count/container) and rendered through the SAME
  scale-then-format stack (one display vocabulary).
- **Edit affordance: press the quantity badge** (owner ruling: "when pressing
  the quantity… make it more accessible and clear it can be edited"). The
  badge must READ as editable — dashed underline + pencil glyph per the
  render; the owner clarified the requirement is *clarity of editability*,
  not a literal `<button>` element, but it must still be a keyboard- and
  AT-reachable control with an accessible name ("Change quantity of X").
  Pressing opens the inline editor under the badge: stepper pill (mono
  value), Reset (drops the override, back to derived), Done. The editor is
  rendered through a `<Teleport to="body">` + `position:fixed` overlay
  (z-50, repositioned to the badge button on open/scroll/resize) so the
  grocery rows' `overflow-hidden` cards cannot clip it when the edited row
  is the last visible one (issue #101 regression). A pointer anywhere outside
  the editor — and outside the badge trigger — also closes it (the popover
  design rule in docs/agents/conventions.md).
- **Grocery tab ONLY** (owner ruling): the editable affordance exists on
  GroceryTab mobile + desktop. ShopView (shopping mode) renders the override
  value but offers NO editing.
- **Household-synced** (owner ruling): the override store joins the room
  payload as a new SharedState field riding the whole-state LWW, with a
  STORE_SLICES backup slice in the same change (ADR-0013 standing rule) and
  registry coverage asserted by the existing goldens.
- **Clamp once:** the edited value normalizes through the shared quantity
  parser/validator before both the store write and the display — same rule
  as ADR-0037's servings (one clamp before both writes).
- **Interaction with cleared lines:** an override on a line identity that is
  currently hidden by cleared claims is inert; the sweep drops it only when
  no rendered line carries the identity.

## Rejected fictions (from the renders, never implement)

- "In Peak Season" pill (desktop modal) — no seasonality data exists.
- The re-generated desktop modal's inert background mock — "Active Run ·
  Week 42", "amber-falcon-lantern · 2 peers", "4 meals planned, 28 items",
  "3/4 pending", the avatar disc, header utility icons — illustrative only.
- The per-recipe-row meta line ("Prep: 25 min · 2 peaches") in the desktop
  modal render — the ADOPTED row contract (mobile sheet) is name + chevron
  only; no per-row meta ships.
- The modal's custom drop shadow and zoom-in animation — Level 3 separates
  by the espresso scrim alone; `shadow-popover` stays the ONE shadow at
  level 2; the scrim is static, never animated (ADR-0068).
- The mock list's invented items ("Oat Milk 3.8% Barista", "Peaches (Ripe
  Yellow)", "Heirloom Tomatoes · 3 pcs") — illustrative only.
- Material Symbols icon names — implementation maps to bundled @lucide/vue
  glyphs (verify the glyph exists in the pinned package and is not already
  semantically claimed; `swap_horiz` → e.g. ArrowLeftRight/Repeat).
- The photo `hover:scale-[1.02]` zoom and the gradient overlay — drop, or
  re-decide at implementation; not part of the contract.
- The desktop grocery render's "Smart grocery consolidation" hint banner and
  "Saved ~2 containers" metric — invented; the existing waste-aware explainer
  card stays the only such copy.

## data-test hooks (pinned by this ADR)

`ingredient-detail` (sheet host) · `ingredient-detail-name` ·
`ingredient-detail-amount` · `ingredient-detail-image` ·
`ingredient-detail-credit` · `ingredient-detail-subs` ·
`ingredient-detail-recipe-row` · `ingredient-detail-close` ·
`grocery-qty-edit` (the editable badge) · `grocery-qty-editor` (the open
stepper) · `grocery-qty-reset`. e2e asserts the sheet opens from BOTH
surfaces, the credit renders only with a photo, substitutes hide when
absent, and the override survives a contributing meal's removal while the
line persists.

## Consequences

- New persisted store slice + room payload field + backup slice — the full
  touch surface of the mealime-add-sync-store skill applies.
- The qty badge becomes interactive on GroceryTab: its hit target must not
  overlap the row label's tap-to-open area (badge stays a right-aligned
  flex sibling; `@click.stop`).
- The sheet lazy-imports `ingredient_detail.json` once (module singleton) —
  the main bundle never carries it (ADR-0099).
