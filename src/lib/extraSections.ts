/**
 * Extras → category sub-sections (ADR-0050).
 *
 * The EXTRA ITEMS group used to be one flat `<ul>` under one static
 * header, and ADR-0015 justified that by rejecting a collapsible extras
 * group: "a chevron there implies a body of items that never appears".
 * The owner reversed that — extras now carry categories the user picked
 * deliberately (ADR-0012/0014's override), so a per-category body really
 * does exist — so the grouping lives here, as a PURE function with its own
 * unit spec, rather than inline in `GroceryTab.vue`. This repo derives and
 * unit-tests (`grocery.ts`, `useGroceryList.ts`, `containers.ts`);
 * component-local aggregation is the pattern to avoid.
 *
 * **What this file must never do** (ADR-0015 §2, still in force): an
 * extra tagged `Produce` lives in the extras group's own `Produce`
 * sub-section and MUST NOT appear in the recipe-derived `Produce` store
 * section. This is a VIEW over `plan.customItems`; nothing here feeds
 * `useGroceryList`, and extras never join a store section.
 */

import { STORE_SECTIONS } from './sections'

/** The named "no category" bucket (ADR-0050 §3, inverting ADR-0015 §3). */
export const UNCATEGORIZED = 'Uncategorized'

/** One extra as the grouping sees it: its display name + remembered category. */
export interface ExtraInput {
  name: string
  /** Remembered store category; missing/empty/`Other` = Uncategorized. */
  category?: string
}

/** One rendered sub-section inside the extras group. */
export interface ExtraGroup {
  /** `STORE_SECTIONS` name, or `Uncategorized`. */
  name: string
  items: ExtraInput[]
}

/**
 * Collapse-state keys are namespaced because extras and store sections
 * share category NAMES: an extras `Produce` sub-section and a real
 * recipe-derived `Produce` section are different groups, and collapsing
 * one must never collapse the other (ADR-0050 §5). Both helpers are pure
 * and unit-tested so the collision is structurally impossible rather than
 * merely asserted by a spec. The `key:` prefix uses a character no store
 * section name contains.
 */
const EXTRA_NS = 'extra:'
const STORE_NS = 'store:'

/** Collapse key for an extras sub-section. */
export function extraCollapseKey(name: string): string {
  return EXTRA_NS + name
}

/** Collapse key for a recipe-derived store section. */
export function storeCollapseKey(name: string): string {
  return STORE_NS + name
}

/** Is this a real `STORE_SECTIONS` name? (`Other` counts — it is the fallback.) */
export function isKnownExtraCategory(category: string | undefined): boolean {
  return !!category && (STORE_SECTIONS as readonly string[]).includes(category)
}

/**
 * Group extras into ordered sub-sections: `STORE_SECTIONS` order, only
 * non-empty groups, `Uncategorized` LAST (mirroring `Other` being last in
 * the constant). A category outside the constant is not "routed" anywhere
 * — it falls into `Uncategorized` with its remembered value intact on the
 * item. Input order is preserved inside each group.
 */
export function groupExtras(extras: ExtraInput[]): ExtraGroup[] {
  const byName = new Map<string, ExtraInput[]>()
  const uncategorized: ExtraInput[] = []

  for (const extra of extras) {
    const category = extra.category?.trim() ?? ''
    const name = isKnownExtraCategory(category) && category !== 'Other' ? category : UNCATEGORIZED
    if (name === UNCATEGORIZED) {
      uncategorized.push(extra)
      continue
    }
    const bucket = byName.get(name)
    if (bucket) bucket.push(extra)
    else byName.set(name, [extra])
  }

  const groups: ExtraGroup[] = []
  for (const section of STORE_SECTIONS) {
    const items = byName.get(section)
    if (items) groups.push({ name: section, items })
  }
  if (uncategorized.length > 0) {
    groups.push({ name: UNCATEGORIZED, items: uncategorized })
  }
  return groups
}