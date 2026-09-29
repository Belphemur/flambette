# ADR-0022: Measured amounts under the cooking step text

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0003 (derived grocery merge keys), ADR-0009 (spice
scaling), ADR-0017 (container units). No catalog data changes; step and
recipe text stay exactly as authored.

## Context

Cooking steps are authored prose with the quantities folded into the
sentence: *"zest and juice from 1 ½ lemon"*, *"juice of ¾ lemon"*,
*"about 3 tbsp extra virgin olive oil"*. The number in the sentence is
often not the quantity you need — the quantity you need lives in the
recipe's `line_items` (`3 lemons`). Cooks complained the app "just says
*a potato*": the step text alone does not carry a measured amount, so
nobody knows whether to buy one potato or three.

In the frozen catalog **41,373 detail lines carry a digit or fraction**,
so an unparseable leading quantity is a real but *narrow* population
(~38 lines recipe-wide, mostly `juice of … lemon/lime`). That is exactly
the right size for a disclosure: rare enough to be worth surfacing,
small enough that it must never become noise.

## Decision

1. **A chip, not a rewrite.** Step text is the author's voice and stays
   verbatim. When a step's detail line does NOT start with a parseable
   amount, and the line names an ingredient whose `line_items` entry has
   a measured quantity, a subdued chip appears under the step:
   `measured: 3 lemons`. Collapsed by default behind an "Ingredient
   amounts (N)" disclosure (`data-test="measured-amounts"`).

2. **Never invent a quantity.** If no line item matches, nothing is
   shown — not a guess, not a parse of the prose. This is the same
   discipline as the timers (ADR-0020): the app surfaces measured facts,
   it does not derive new ones from text.

3. **Matching is `nameKey` containment at word boundaries** — the
   singularization `grocery.ts` already uses, so `lemons` matches
   `lemon` and `tomatoes` matches `tomato`, while `chick` does not match
   `chicken`. A head-noun match (`a potato` → `russet potato`) is
   accepted **only when unambiguous**: if two line items share the head
   noun, nothing is shown.

4. **Scaling is imported, never duplicated.** Container units
   (`½ (142 g) pkg`) take ADR-0017's ceil-merged path
   (`parseContainerQuantity` + `containerContribution` +
   `formatContainerQuantity`); spoon/count units take ADR-0009's linear,
   seasoning-aware `scaleQuantity`. At the authored servings the chip
   shows the AUTHORED text verbatim, matching the grocery list's
   authored-servings policy.

5. **Per line, in step order.** A detail line naming two imprecise
   ingredients yields two chips; chips render in the order their lines
   appear, inside the step they belong to (a Meanwhile partner carries
   its own).

6. **Line items are per-recipe, and the chips say so implicitly.** We do
   NOT pretend a line item belongs to a specific step — a chip is
   surfaced on the step whose prose mentions the ingredient, which is a
   hint, not an allocation. That is why the disclosure is collapsed and
   labeled: it is "the measured amount for this ingredient", not "the
   amount this step consumes".

## Alternatives considered

- **Rewrite the step prose** ("juice of ¾ lemon (3 lemons)"). Rejected:
  it mutates the author's voice and would leak into recipe/cooking step
  text that must stay authentic.
- **Match the step's primary sentence too.** Rejected: primary prose
  mentions ingredients constantly ("add the onions and toss"), so chips
  would appear on nearly every step — the disclosure would become the
  default reading experience and the signal would be lost.
- **Pull quantities from `variant_meta.ingredient_names`.** Rejected: the
  catalog has no quantities there (ADR-0018), only names.
- **Resolve ambiguous head-noun matches by picking the first.** Rejected:
  attributing the wrong ingredient's number is worse than silence.

## Consequences

- A cook who reads "juice of ¾ lemon" can see the real amount without
  leaving the cooking view, at whatever servings they planned.
- The chip count is data-driven and rare: most recipes show nothing,
  which is the intended failure mode.
- Matching quality depends on `nameKey`, shared with the grocery list,
  so improving singularization improves both surfaces at once.
