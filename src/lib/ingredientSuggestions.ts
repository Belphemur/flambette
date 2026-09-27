/**
 * Ingredient suggestions for the grocery add-item autocomplete (ADR-0012).
 *
 * Sources, in rank priority:
 *  1. The baked ingredient index (public/data/ingredients.json, built by
 *     scripts/extract_ingredients.py — offline data, no runtime fetch).
 *  2. Device-local remembered names (customIngredients store) that don't
 *     match the index — suggestions marked "mine".
 *
 * Ranking for index matches on the nameKey query: typed-prefix match >
 * word-boundary match > substring match; ties break alphabetically.
 * Custom names merge AFTER index matches, same rank rules within their tier.
 */

import { nameKey } from './grocery'
import type { CustomIngredient } from '../stores/customIngredients'
import type { StoreSection } from './sections'

export interface IngredientSuggestion {
  /** Display name (e.g. "yellow potatoes"). */
  name: string
  /** Merge key (e.g. "yellow potato"). */
  nameKey: string
  /** Store section suggested for this ingredient. */
  category: StoreSection | string
  /** True when the suggestion comes from the user's own typed history. */
  mine: boolean
  /** Unit hint from the index (undefined for custom entries). */
  unit?: string
}

interface IndexEntry {
  name: string
  nameKey: string
  category: string
  unit: string | null
}

/** Match tier within a source: lower wins. */
type Tier = 0 | 1 | 2

interface Scored {
  suggestion: IngredientSuggestion
  tier: Tier
}

const MAX_SUGGESTIONS = 8

let indexPromise: Promise<IndexEntry[]> | null = null

/** Lazily load + freeze the baked index (dynamic import, once). */
function loadIndex(): Promise<IndexEntry[]> {
  indexPromise ??= import('../../public/data/ingredients.json').then(
    (mod) => (mod.default as { ingredients: IndexEntry[] }).ingredients,
  )
  return indexPromise
}

function scoreIndexEntry(entry: IndexEntry, key: string): Tier | null {
  const nk = entry.nameKey
  if (nk.startsWith(key)) return 0
  if (new RegExp(`\\b${key}`).test(nk)) return 1
  if (nk.includes(key)) return 2
  return null
}

function scoreCustom(entry: CustomIngredient, key: string): Tier | null {
  const nk = entry.nameKey
  if (nk.startsWith(key)) return 0
  if (new RegExp(`\\b${key}`).test(nk)) return 1
  if (nk.includes(key)) return 2
  return null
}

/**
 * Suggestions for the typed query. Empty query (after nameKey
 * normalization) yields no suggestions — the dropdown stays closed.
 */
export async function suggestIngredients(
  query: string,
  custom: CustomIngredient[],
): Promise<IngredientSuggestion[]> {
  const key = nameKey(query.trim())
  if (key.length < 2) return []

  const index = await loadIndex()

  const scoredIndex: Scored[] = []
  for (const entry of index) {
    const tier = scoreIndexEntry(entry, key)
    if (tier !== null) {
      scoredIndex.push({
        suggestion: {
          name: entry.name,
          nameKey: entry.nameKey,
          category: entry.category,
          mine: false,
          unit: entry.unit ?? undefined,
        },
        tier,
      })
    }
  }

  const scoredCustom: Scored[] = []
  const seenKeys = new Set(scoredIndex.map((s) => s.suggestion.nameKey))
  for (const entry of custom) {
    if (seenKeys.has(entry.nameKey)) continue
    const tier = scoreCustom(entry, key)
    if (tier !== null) {
      seenKeys.add(entry.nameKey)
      scoredCustom.push({
        suggestion: {
          name: entry.name,
          nameKey: entry.nameKey,
          category: entry.category,
          mine: true,
        },
        tier,
      })
    }
  }

  sortScored(scoredIndex)
  sortScored(scoredCustom)

  return [...scoredIndex, ...scoredCustom]
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.suggestion)
}

/** tier asc, then alphabetical (name) — stable across retries. */
function sortScored(list: Scored[]): void {
  list.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.suggestion.name.localeCompare(b.suggestion.name, 'en', { sensitivity: 'base' }),
  )
}
