# ADR-0036: A kitchen companion, not an accent-only reskin

**Status:** Design approved for implementation by the owner's delegated design review; not shipped.
**Supersedes:** the visual direction in [ADR-0035](ADR-0035-design-tokens-and-categorical-hues.md).
**Normative specification:** [root DESIGN.md](../../DESIGN.md).

## Context

The owner reported redundant category labels, inconsistent food icons, a
vegetarian/vegan distinction that was unclear, and a dark-mode Start cooking
action that was hard to find. They also requested a wider desktop experience,
more colour and subtle bottom-navigation hover motion, then explicitly allowed
a complete design rethink rather than preservation of the current layout.

Review of README, AGENTS and ADRs 0024/0032/0033/0034 establishes the purpose:
a household chooses meals, reuses ingredients through waste-aware planning,
shops from a derived shared list, and cooks with minimal friction. A plan is
an unscheduled set of meals, not a calendar. Cooking any recipe remains possible
without building a plan first. The visual system must support that whole loop.

ADR-0035's restraint went too far: it limited colour mostly to tiny icons,
locked the phone layout, squeezed five desktop columns inside an 1100px cap,
and left competing light-card/background instructions. Its selected-chip and
icon identity rules also conflicted. A lint pass did not prove visible controls.

## Decision

1. Replace that direction with the **Mealime Kitchen** specification: cream,
   white and espresso surfaces, confident tomato actions, clear food-category
   cues, generous reading type and intentional composition for each task.
2. Broaden the redesign across responsive surfaces, including mobile, while
   preserving behaviour, data, routes, offline assets, five labelled tabs and
   practical touch targets. No runtime dependencies, font downloads or AI service.
3. Keep the 1100px shared shell, use at most four desktop recipe columns, and
   compose desktop recipe detail as photo/summary followed by ingredient/step
   columns. Focused cooking retains its 672px reading measure.
4. Give Start cooking sole primary emphasis in recipe detail, a visible tomato
   fill and white label in both themes, plus a dark-theme keyline. Add/Update in
   plan remains readily available as a secondary action. Test boundaries as well
   as foreground/background text contrast.
5. Use one semantic icon registry: Beef/meat, Fish/fish, green Salad/vegetarian,
   distinct mint Sprout/vegan, Flame/energy, Droplet/sodium. Catalog category is
   not a vegan certification. Remove duplicate category words from cards and
   detail headers but keep accessible names and filter labels. Sodium belongs
   in nutrition, not the compact browsing metadata row.
6. Use tinted selected controls with explicit selection semantics, so category
   colours remain legible instead of sitting on an opaque tomato chip. Retain
   the 2px/150ms hover-capable nav-icon motion and reduced-motion handling.
7. DESIGN.md is authoritative for tokens AND composition. Tailwind and the
   generated DTCG file mirror it and require parity checks. Verify built UI in
   light/dark, phone/tablet/desktop, keyboard, zoom and reduced-motion states,
   inspect screenshots, then run the complete behavioural suite.

## Consequences and trade-offs

- This is intentionally broader than the original colour patch, but not a
  product/state rewrite. Surface and typography migrations touch multiple views.
- Four desktop columns favour legibility and food photography over maximal
  density. Small phones retain compact cards and can fall back to one column.
- System fonts favour offline reliability and zero extra transfer over a new
  branded webfont. Cream/espresso and type hierarchy carry the identity instead.
- A shared registry and token parity reduce drift; rendered-state checks remain
  necessary because correct tokens can be overridden, absent or on the wrong fill.
- README contains stale history-default and regeneration descriptions; reconcile
  those from the newer behaviour ADRs rather than redesigning the behaviour.
- Existing gates may intentionally fail between this specification change and
  implementation. Do not present that interim state as a finished feature.

## Alternatives considered

- Keep the grey foundation and only colour icons: rejected; it preserves the
  blandness and hierarchy problems the owner reported.
- Force dark cards in light mode or make every surface brightly coloured:
  rejected; theme coherence and food imagery matter more than novelty.
- Introduce a desktop sidebar, new navigation destinations, a calendar or an
  LLM meal planner: unnecessary scope and contrary to the product's existing
  constraints. Modernise the working surfaces instead.
- Keep five columns and shrink text: rejected; width should improve usability,
  not merely increase density.
