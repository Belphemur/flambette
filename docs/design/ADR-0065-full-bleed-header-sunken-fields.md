# ADR-0065: Full-bleed desktop header and sunken-well input fields

Status: accepted (2026-10-09)

## Context

DESIGN.md's shared frame (ADR-0036 revision) pins one `container` token —
1100px — for header, main content and bottom-navigation alignment. Above
1100px the header bar therefore floats as a capped strip with page fill
showing at its sides, while the bottom navigation is already full-window
chrome (`fixed inset-x-0`) whose tabs align to the container, and the
stale-version banner (ADR-0061) already spans the viewport. On wide screens
the header reads as accidentally boxed rather than deliberately capped:
the chrome surfaces disagree about whether they belong to the window or to
the content column.

Input fields have the opposite problem: they are visually indistinguishable
from their surroundings. Today a field is 44px, `rounded-xl`, filled with
`surface` or `surface-raised` (the same white/cream as every card) with a
pale `border` keyline — and some fields set no border colour at all. Focus
only swaps the keyline to the brand text colour. Nothing marks a field as a
receptive well that wants typing, and each view spells its own field classes,
so the language drifts per surface.

The owner ruled on both (2026-10-09): the header becomes full-window chrome
with its content aligned to the container, and fields adopt a sunken-well
language shared by every field in the app.

## Decision

1. **Header chrome is full-window.** The header bar's background and bottom
   border span the viewport edge to edge on every width (below 1100px this is
   already the case, so mobile and the Pixel 7 layout are unchanged); the
   content row inside it — logo, app version, room chip — aligns to the
   1100px container, exactly as the bottom navigation already does. The
   header and the bottom nav become symmetric chrome around the capped
   content column. No new tokens: the bar keeps `surface-raised` with a
   `border` edge. The shell keeps `max-w-app` for main content; ADR-0016's
   pinned 82px/tab fit is untouched. Cooking and shopping are fullscreen
   modes with no header and are unaffected.

2. **Fields are sunken wells.** Every free-text field — recipe search,
   ingredient add-rows, settings inputs, cooking-view scale and note inputs,
   textareas — rests on a `surface-sunken` fill (the peach-cream band token)
   with a 1px `border-strong` control keyline (the existing `control-border`
   colour), keeping the 12px `rounded.lg` radius and 44px touch height.
   Focus deepens the keyline to the action-text colour (`primary-strong`,
   `primary-soft` in dark) beneath the global 2px `focus-visible` ring.
   Dark mode flips entirely through the existing token pairs — no new colour
   tokens, no `dark:` utilities. The language ships as ONE shared field
   class in `src/style.css`; per-view one-off field styling is retired.
   Measured pairs (worst case per state): value text on the well
   **13.6:1** light (`text` on `surface-sunken`) / **13.9:1** dark;
   idle keyline **3.69:1** light / **4.69:1** dark against the well; focus
   keyline **7.48:1** light / **5.97:1** dark — all above the 4.5:1 text and
   3:1 non-text bars. Hit targets, tap areas and step/recipe prose are
   unchanged (grocery/recipe text stays authentic per ADR-0017's display
   rule).

## Consequences

- DESIGN.md's Layout section is reworded: chrome bars span the window;
  content (and chrome content rows) align to the container. The "bottom bar
  may have a full-window background" sentence is generalised to both bars.
- New `field` / `field-dark` `components:` entries document the well with
  existing token references. Component entries are documentation-only, so
  `DESIGN.tokens.json` and the `palette.test.ts` parity test do not move.
- The `.field` class in `src/style.css` becomes the one place a field look
  exists; new inputs pick it up by adding the class, never by re-spelling
  the utilities.
- E2E assertions that read header bounding boxes or field classes may need
  re-pinning; behaviour (routes, handlers, `data-test` hooks) does not
  change.

## Alternatives considered

- **Full-width header content** (logo pinned at the viewport edge): rejected
  — it breaks the alignment contract between the header and the content
  column below it and reads as a different app above 1100px.
- **A different chrome surface** (`surface` instead of `surface-raised` for
  the header band): rejected — the bottom nav already uses `surface-raised`;
  symmetry and token economy win over a third band colour.
- **Raised card fields** (white fill + shadow): rejected — it doubles the
  shadow vocabulary with recipe cards and lifts a control that should
  receive input, not float.
- **Focus-halo only** (neutral at rest, brand-tint flood on focus): rejected
  as the whole language — an invisible-at-rest field is the current defect.
- **Always brand-tinted fields**: rejected — `primary-tint` is the SELECTION
  colour (ADR-0036's chip contract); a field is not a selection, and the
  tint would compete with selected chips on the same screens.
