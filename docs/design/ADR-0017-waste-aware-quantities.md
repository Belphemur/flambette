# ADR-0017: Container units are purchased, not divided (waste-aware grocery lines)

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0009 (sub-linear seasoning scaling), ADR-0004
(derived grocery list). The aggregation itself is unchanged — only how
one class of unit is scaled and rendered.

## Context

The frozen catalog phrases many line items in the unit they are
actually *bought* in, with real container fractions:

```
1 head · ½ (142 g) pkg · ½ small bunch · ¾ (227 g) block · 1 small pkg
3 (398 ml) cans · 2 ½ cm pieces · 1 head
```

Across the catalog `pkg` appears 1,400+ times, `bunch` 1,300+,
`head`/`can`/`block` in the hundreds, and ~2,400 quantities are an
explicit half. The grocery aggregator treated every one of these as a
measure: it summed the numeric amount and re-printed it, so two recipes
each asking for `½ (142 g) pkg` produced the shopper-hostile `1.5 (142
g) pkgs` — and the underlying truth is simpler and cheaper: **you buy
one package**.

The old rendering was also lossy: `½ (142 g) pkg` displayed as
`0.5 (142 g) pkg`, throwing away the authored fraction that a shopper
reads as "half a bag".

## Decision

1. **A container unit is a purchasable unit.** `src/lib/containers.ts`
   classifies a line-item quantity as a container unit when it parses to
   a positive count plus an optional `(annotation)` and an
   adjective+noun phrase whose noun is a purchasable container
   (`pkg`, `bunch`, `head`, `can`, `block`, `bag`, `jar`, `log`,
   `loaf`, `bottle`, `box`, `tin`, `carton`, `ear`, `stick`, `crown`,
   `heart`, `cap`) with only size adjectives in front
   (`small`/`medium`/`large`/`big`/`jumbo`/`mini`/`extra-large`).
   Count nouns that are not containers (cloves, slices, pieces, cups,
   stalks) and spoon/measure units are explicitly **not** container
   units.

2. **Container units do not scale linearly.** A recipe for 6 that uses
   `½ small bunch`, planned for 12 servings, needs **1** whole bunch —
   you cannot buy half of a bunch. Per-recipe contribution is therefore
   `count` at the authored servings and `ceil(count × factor)` above
   them (min 1). The shopping result rounds *up to the purchasable
   container*, which is the whole waste-reduction insight: bigger
   batches stop inflating the package count.

3. **Merging is per (container, annotation).** The merge key is
   `unitKey(container) | annotation`, so `½ (142 g) pkg` +
   `½ (142 g) pkg` = `1 (142 g) pkg`, while a `(113 g) pkg` of the same
   ingredient stays a separate line — the two are not interchangeable.
   The annotation is preserved **verbatim**, including the catalog's
   inner-space spellings (`(227g ) pkgs`).

4. **Rendering.** A single meal at its own serving count keeps the
   recipe's authored text (`½ (142 g) pkg`) so the list still reads like
   the recipe. Anything merged or scaled renders as a count: whole
   numbers as whole containers (`1 (142 g) pkg`, `2 (142 g) pkgs`),
   sums with a remainder as mixed fractions (`1 1/4 (142 g) pkgs`,
   `3/2 small bunches`) via the new `formatFraction` helper
   (thirds/quarters/sixths/eighths, 1-decimal fallback).

5. **Everything else is untouched.** Spoon/measure units keep ADR-0009's
   linear (or sub-linear, capped) scaling, `cloves`/`slices` keep
   summing, unparseable quantities pass through verbatim, and the
   recipe detail / cooking views keep the authentic step text — the
   change is confined to the grocery aggregation boundary in
   `src/lib/grocery.ts`.

## Consequences

- The grocery list shows packages, not fractions of packages, which is
  what a shopper carries to the store.
- Container quantities are *conservative* (rounded up), never
  short. That is intentional: under-buying a package breaks the recipe.
- The change is presentation + arithmetic only; keys, sections, the
  checked-state map and provenance are unchanged, so existing
  checkbox behaviour and backup payloads are unaffected (a saved
  `checked` key for a rewritten `display` simply no longer matches — the
  same situation as any display change).
- Pure functions with unit tests (`src/lib/containers.test.ts`,
  `src/lib/grocery.test.ts`, run via `bun run test:unit`).
