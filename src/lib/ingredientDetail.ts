/**
 * Ingredient detail data layer (ADR-0099): the fused
 * `public/data/ingredient_detail.json` corpus — local webp image paths +
 * owner-curated kitchen substitutes, keyed by the grocery `nameKey`.
 *
 * The artifact is a FIXED index universe (871 grocery nameKeys, 661
 * entries), so it is loaded as ONE module-singleton chunk through a
 * DYNAMIC import — the same lazy pattern `ingredientSuggestions.ts`
 * established for `ingredients.json`. The main bundle must never carry
 * the corpus: users who never open the detail sheet never download it
 * (~76 KB raw / ~15 KB gzipped, one-time, browser-cached).
 *
 * PURE lib (no Vue import): the load is a memoized promise, the accessor
 * is a pure function over the entries map, so bun-test can pin the
 * fallback shapes without a browser.
 */

/** One typed view of one ingredient's detail row, safe-empty by design. */
export interface IngredientDetail {
  /** Local webp path as stored in the artifact (`img/ingredients/…`). */
  image?: string
  /** Full offline src for the `image` path — BASE_URL-prefixed. */
  imageSrc?: string
  /** The sheet's attribution line, present exactly when an image renders. */
  credit?: string
  /** Owner-curated substitute strings (informational prose, ADR-0100). */
  substitutes?: string[]
}

interface CorpusEntry {
  image?: string
  substitutes?: string[]
}

interface IngredientDetailFile {
  entries: Record<string, CorpusEntry>
}

let entriesPromise: Promise<Record<string, CorpusEntry>> | null = null

function loadEntries(): Promise<Record<string, CorpusEntry>> {
  entriesPromise ??= import('../../public/data/ingredient_detail.json').then(
    (mod) => (mod.default as IngredientDetailFile).entries,
  )
  return entriesPromise
}

/**
 * Load the detail for ONE nameKey (single-flight — the corpus chunk is
 * fetched at most once per page). Missing data is EMPTY, never a throw:
 * a nameKey outside the 661-entry universe (user-recipe ingredients,
 * unmatched rows) renders the aisle-glyph fallback and no substitutes.
 */
export async function loadIngredientDetail(nameKey: string): Promise<IngredientDetail> {
  const entries = await loadEntries()
  return ingredientDetailFrom(entries, nameKey)
}

/**
 * PURE accessor over the loaded entries map (the unit-test seam): shape a
 * corpus row into the typed view with its safe empty fallbacks.
 * - no row → an empty detail (the sheet hides the sections)
 * - image-only row → image + imageSrc + the TheMealDB credit (ADR-0099:
 *   the attribution is PART of the detail — visible, not repo-metadata)
 * - substitutes-only row → substitutes alone, no credit, no image
 */
export function ingredientDetailFrom(
  entries: Record<string, CorpusEntry>,
  nameKey: string,
): IngredientDetail {
  const row = entries[nameKey]
  if (!row) return {}
  const detail: IngredientDetail = {}
  if (typeof row.image === 'string' && row.image) {
    const base = import.meta.env.BASE_URL ?? '/'
    detail.image = row.image
    detail.imageSrc = `${base}${row.image}`
    detail.credit = 'Photo: TheMealDB'
  }
  if (Array.isArray(row.substitutes) && row.substitutes.length > 0) {
    detail.substitutes = row.substitutes.filter((s) => typeof s === 'string' && s.length > 0)
  }
  return detail
}
