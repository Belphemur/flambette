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
 *
 * Tier 3 (ADR-0086): when the exact tiers leave room under the cap, a
 * MiniSearch fuzzy tier over BOTH sources fills the remaining rows — a
 * typo ("bananna") still surfaces "banana", and a typo'd remembered
 * ("mine") name is still found. Exact rows always outrank fuzzy rows.
 */

import MiniSearch, { type Options } from 'minisearch'
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

/** Document indexed by the fuzzy tier's MiniSearch instance (ADR-0086). */
interface FuzzyDoc {
  id: string
  /** The nameKey — the same normalized vocabulary the exact tiers match. */
  key: string
  name: string
  category: string
  unit?: string
  mine: boolean
}

/** Same tuning the recipe search uses (src/lib/search.ts, ADR-0086 §2). */
const FUZZY_INDEX_OPTIONS: Options<FuzzyDoc> = {
  fields: ['key'],
  idField: 'id',
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
  },
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

/**
 * ONE lazily-built MiniSearch instance indexing BOTH sources as
 * first-class documents: the baked index entries AND the household's
 * custom ingredients. Rebuilt only when a source identity changes —
 * the baked index is a frozen module singleton and the custom store
 * replaces its array on every mutation, so array identity is the key.
 */
let fuzzyCache: {
  index: MiniSearch<FuzzyDoc>
  docs: Map<string, FuzzyDoc>
  forIndex: IndexEntry[]
  forCustom: CustomIngredient[]
} | null = null

async function getFuzzyIndex(
  custom: CustomIngredient[],
): Promise<{ index: MiniSearch<FuzzyDoc>; docs: Map<string, FuzzyDoc> }> {
  const indexEntries = await loadIndex()
  if (fuzzyCache?.forIndex === indexEntries && fuzzyCache.forCustom === custom) {
    return { index: fuzzyCache.index, docs: fuzzyCache.docs }
  }
  const docs = new Map<string, FuzzyDoc>()
  const keys = new Set<string>()
  for (const entry of indexEntries) {
    const id = `i:${entry.nameKey}`
    keys.add(entry.nameKey)
    docs.set(id, {
      id,
      key: entry.nameKey,
      name: entry.name,
      category: entry.category,
      unit: entry.unit ?? undefined,
      mine: false,
    })
  }
  // Custom names participate exactly like index entries — but an index
  // entry with the same nameKey owns the row (dedupe by nameKey, ADR-0086
  // §4): ONE document per key, so a fuzzy hit can never yield duplicates.
  for (const entry of custom) {
    const id = `m:${entry.nameKey}`
    if (keys.has(entry.nameKey)) continue
    keys.add(entry.nameKey)
    docs.set(id, {
      id,
      key: entry.nameKey,
      name: entry.name,
      category: entry.category,
      mine: true,
    })
  }
  const index = new MiniSearch<FuzzyDoc>(FUZZY_INDEX_OPTIONS)
  index.addAll([...docs.values()])
  fuzzyCache = { index, docs, forIndex: indexEntries, forCustom: custom }
  return { index, docs }
}

/** A fuzzy-tier row kept with its MiniSearch score for the final sort. */
interface FuzzyHit {
  suggestion: IngredientSuggestion
  score: number
}

/**
 * Tier 3 (ADR-0086): MiniSearch fuzzy hits over BOTH sources, deduped
 * by nameKey against the exact rows already selected, capped to the
 * remaining room, ordered by MiniSearch score then alphabetical name
 * (same stability rule as sortScored — deterministic, e2e-pinnable).
 */
async function fuzzyRows(
  key: string,
  custom: CustomIngredient[],
  exactKeys: Set<string>,
  room: number,
): Promise<IngredientSuggestion[]> {
  if (room <= 0) return []
  const { index, docs } = await getFuzzyIndex(custom)
  const hits = index.search(key, { fields: ['key'], prefix: true, fuzzy: 0.2 })
  const picked: FuzzyHit[] = []
  const pickedKeys = new Set<string>()
  for (const hit of hits) {
    if (picked.length >= room) break // hits come score-desc: top-room kept
    const doc = docs.get(hit.id as string)
    if (!doc || exactKeys.has(doc.key) || pickedKeys.has(doc.key)) continue
    pickedKeys.add(doc.key)
    picked.push({
      suggestion: {
        name: doc.name,
        nameKey: doc.key,
        category: doc.category,
        mine: doc.mine,
        unit: doc.unit,
      },
      score: hit.score,
    })
  }
  picked.sort(
    (a, b) =>
      b.score - a.score ||
      a.suggestion.name.localeCompare(b.suggestion.name, 'en', { sensitivity: 'base' }),
  )
  return picked.map((h) => h.suggestion)
}

/**
 * Rank a nameKey against the query key (DRY): the index rows and the
 * household's custom rows are the SAME shape for scoring, so one
 * scorer serves both. Tier 0 = the key starts the nameKey, tier 1 =
 * a word boundary matches, tier 2 = a substring match.
 */
function scoreNameKey(nk: string, key: string): Tier | null {
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
    const tier = scoreNameKey(entry.nameKey, key)
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
    const tier = scoreNameKey(entry.nameKey, key)
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

  // Exact tiers 0-2 keep their exact semantics and order byte-for-byte
  // (ADR-0086 §1): the cap cuts HERE, before any fuzzy work, so a query
  // whose exact matches fill the cap renders identically to today.
  const rows = [...scoredIndex, ...scoredCustom]
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.suggestion)
  if (rows.length === MAX_SUGGESTIONS) return rows

  // Tier 3: fuzzy rows fill ONLY the rows the exact tiers left empty.
  return [
    ...rows,
    ...(await fuzzyRows(key, custom, seenKeys, MAX_SUGGESTIONS - rows.length)),
  ]
}

/** tier asc, then alphabetical (name) — stable across retries. */
function sortScored(list: Scored[]): void {
  list.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.suggestion.name.localeCompare(b.suggestion.name, 'en', { sensitivity: 'base' }),
  )
}

/**
 * Is the suggestion LISTBOX rendered right now? Pure, and the single
 * answer for the `v-if` AND `aria-expanded` / `aria-controls` /
 * `aria-activedescendant` (qodo + kody-ai, the same finding twice).
 *
 * The category popup draws over the input, so while it is open the
 * suggestion rows stand down — but the combobox must stand down with
 * them, or it announces an expanded listbox whose node is not in the
 * DOM. Keeping the rule here (rather than inline in the component) is
 * what makes the four call sites provably agree.
 */
export function isSuggestionListVisible(state: {
  open: boolean
  categoryMenuOpen: boolean
  rowCount: number
}): boolean {
  return state.open && !state.categoryMenuOpen && state.rowCount > 0
}
