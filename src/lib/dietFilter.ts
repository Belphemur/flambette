/**
 * Rule-based diet classifier over the frozen catalog — ADR-0018.
 *
 * The snapshot has NO diet/allergen metadata (verified across all
 * 2,730 recipe documents), so the only signal available is the
 * ingredient names themselves. This module matches curated keyword
 * tables against those names, per diet rule.
 *
 * Accuracy note: this is a *heuristic suggestion lens*, not a
 * guarantee. It has known false positives (a dish listing "chicken
 * broth" is meat-free-ish but not vegan; "oat milk" is handled by an
 * explicit exemption, other compound names are not modelled). False
 * negatives exist too ("vegetable stock" written where the maker means
 * a meat stock). See docs/design/ADR-0018-diet-rules.md.
 *
 * Pure + memoized: the app classifies the catalog once at load time
 * (2,730 recipes is nothing) and e2e reuses the exact same function,
 * so the chips and the assertions can never disagree.
 */

/* ---------- Ingredient tokenization ---------- */

/**
 * Lowercase a name and split it into singular tokens. Word-boundary
 * matching is what keeps `egg` from firing on `eggplant` and `ham` from
 * firing on `chamfer`.
 */
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(singular)
}

function singular(t: string): string {
  if (/(ches|shes|sses|xes|zes)$/.test(t) && t.length > 4) return t.slice(0, -2)
  if (/oes$/.test(t) && t.length > 4) return t.slice(0, -2)
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && t.length > 3) return t.slice(0, -1)
  return t
}

/* ---------- Keyword groups ---------- */

export type DietId = 'no-pork' | 'no-shellfish' | 'no-meat' | 'vegetarian' | 'vegan'

export const DIET_IDS: readonly DietId[] = ['no-pork', 'no-shellfish', 'no-meat', 'vegetarian', 'vegan']

/** Chip labels (short, chip-width friendly). */
export const DIET_LABELS: Record<DietId, string> = {
  'no-pork': 'No-pork',
  'no-shellfish': 'No-shellfish',
  'no-meat': 'No-meat',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
}

/** Long descriptions, used for the chip `aria-label` and the ADR. */
export const DIET_DESCRIPTIONS: Record<DietId, string> = {
  'no-pork': 'No pork, bacon, ham or lard',
  'no-shellfish': 'No shrimp, lobster, crab or other shellfish',
  'no-meat': 'No meat or poultry (fish is fine)',
  vegetarian: 'No meat, fish or shellfish',
  vegan: 'No meat, fish, dairy, eggs or honey',
}

const PORK = 1 << 0
const SHELLFISH = 1 << 1
const MEAT = 1 << 2
const FISH = 1 << 3
const DAIRY = 1 << 4
const EGG = 1 << 5
const HONEY = 1 << 6
/** Animal products that hide under a savoury name (ADR-0018 anomalies). */
const HIDDEN = 1 << 7

/** keyword phrase -> group bitmask (one phrase can belong to two groups). */
type KeywordTable = ReadonlyArray<readonly [string, number]>

const PORK_WORDS: KeywordTable = [
  ['pork', PORK | MEAT],
  ['bacon', PORK | MEAT],
  ['pancetta', PORK | MEAT],
  ['prosciutto', PORK | MEAT],
  ['ham', PORK | MEAT],
  ['chorizo', PORK | MEAT],
  ['lard', PORK | MEAT | HIDDEN],
  ['guanciale', PORK | MEAT],
  ['salami', MEAT],
  ['pepperoni', MEAT],
  ['sausage', MEAT],
]

const SHELLFISH_WORDS: KeywordTable = [
  ['shrimp', SHELLFISH],
  ['prawn', SHELLFISH],
  ['lobster', SHELLFISH],
  ['crab', SHELLFISH],
  ['clam', SHELLFISH],
  ['mussel', SHELLFISH],
  ['oyster', SHELLFISH],
  ['scallop', SHELLFISH],
  ['crawfish', SHELLFISH],
  ['crayfish', SHELLFISH],
  ['squid', SHELLFISH],
  ['octopus', SHELLFISH],
  ['anchovy', SHELLFISH | FISH],
  ['caviar', SHELLFISH | FISH],
]

const MEAT_WORDS: KeywordTable = [
  ['beef', MEAT],
  ['steak', MEAT],
  ['steakette', MEAT],
  ['brisket', MEAT],
  ['rib', MEAT],
  ['sirloin', MEAT],
  ['veal', MEAT],
  ['lamb', MEAT],
  ['mutton', MEAT],
  ['chicken', MEAT],
  ['turkey', MEAT],
  ['duck', MEAT],
  ['goose', MEAT],
  ['rabbit', MEAT],
  ['bacon', MEAT],
  ['ham', MEAT],
  ['prosciutto', MEAT],
  ['meat', MEAT],
  ['mince', MEAT],
  ['minced', MEAT],
  ['meatball', MEAT],
  ['bolognese', MEAT],
  // Anomalies: stock-family names almost always mean animal stock.
  ['broth', MEAT | HIDDEN],
  ['stock', MEAT | HIDDEN],
  ['bouillon', MEAT | HIDDEN],
  ['gravy', MEAT | HIDDEN],
]

const FISH_WORDS: KeywordTable = [
  ['fish', FISH],
  ['salmon', FISH],
  ['tuna', FISH],
  ['cod', FISH],
  ['haddock', FISH],
  ['halibut', FISH],
  ['tilapia', FISH],
  ['trout', FISH],
  ['mackerel', FISH],
  ['sardine', FISH],
  ['perch', FISH],
  ['bass', FISH],
  ['monkfish', FISH],
  ['dashi', FISH | HIDDEN],
  ['worcestershire', FISH | HIDDEN],
]

const DAIRY_WORDS: KeywordTable = [
  ['milk', DAIRY],
  ['butter', DAIRY],
  ['cheese', DAIRY],
  ['cream', DAIRY],
  ['creme fraiche', DAIRY],
  ['yogurt', DAIRY],
  ['yoghurt', DAIRY],
  ['mozzarella', DAIRY],
  ['parmesan', DAIRY],
  ['parmigiano', DAIRY],
  ['feta', DAIRY],
  ['cheddar', DAIRY],
  ['mascarpone', DAIRY],
  ['ricotta', DAIRY],
  ['ghee', DAIRY | HIDDEN],
  ['custard', DAIRY],
  ['alfredo', DAIRY],
  ['bechamel', DAIRY],
  ['pecorino', DAIRY],
  ['brie', DAIRY],
  ['gouda', DAIRY],
]

const EGG_WORDS: KeywordTable = [
  ['egg', EGG],
  ['mayonnaise', EGG],
  ['meringue', EGG],
  ['aioli', EGG],
  ['hollandaise', EGG],
]

const HONEY_WORDS: KeywordTable = [
  ['honey', HONEY],
  ['beeswax', HONEY],
]

/** Everything that is not vegan even when the name looks plant-based. */
const HIDDEN_WORDS: KeywordTable = [
  ['gelatin', HIDDEN],
  ['gelatine', HIDDEN],
  ['rennet', HIDDEN],
  ['carmine', HIDDEN],
  ['lard', HIDDEN],
  ['shortening', HIDDEN],
  ['fish sauce', FISH | HIDDEN],
  ['shrimp paste', SHELLFISH | FISH | HIDDEN],
  ['oyster sauce', SHELLFISH | FISH | HIDDEN],
  ['worcestershire', FISH | HIDDEN],
  ['dashi', FISH | HIDDEN],
]

/**
 * Exemptions: phrases that carry a forbidden word but are not actually
 * from the forbidden group. Suppressed group bits are per ingredient.
 * - plant milks / creams contain "milk"/"cream" but are not dairy;
 * - vegetable stock/broth is not meat stock.
 */
const DAIRY_EXEMPTIONS: ReadonlyArray<readonly string[]> = [
  // "butter beans" and "apple butter" are plant ingredients that merely
  // contain the word.
  ['butter', 'bean'],
  ['apple', 'butter'],
  ['oat', 'milk'],
  ['almond', 'milk'],
  ['soy', 'milk'],
  ['rice', 'milk'],
  ['coconut', 'milk'],
  ['cashew', 'milk'],
  ['coconut', 'cream'],
  ['oat', 'cream'],
  ['almond', 'cream'],
  ['cashew', 'cream'],
]

const MEAT_EXEMPTIONS: ReadonlyArray<readonly string[]> = [
  ['vegetable', 'stock'],
  ['vegetable', 'broth'],
  // The catalog's stock-family line item is literally "chicken or
  // vegetable broth" — a choice, not a commitment to chicken.
  ['chicken', 'or', 'vegetable', 'broth'],
]

/** Bitmask of groups each diet forbids. */
const DIET_FORBIDS: Record<DietId, number> = {
  'no-pork': PORK,
  'no-shellfish': SHELLFISH,
  'no-meat': MEAT,
  vegetarian: PORK | SHELLFISH | MEAT | FISH | HIDDEN,
  vegan: PORK | SHELLFISH | MEAT | FISH | HIDDEN | DAIRY | EGG | HONEY,
}

/** Flattened, de-duplicated keyword index: token sequence -> group bitmask. */
interface IndexedKeyword {
  tokens: string[]
  mask: number
}

function buildIndex(tables: readonly KeywordTable[]): IndexedKeyword[] {
  const merged = new Map<string, number>()
  for (const table of tables) {
    for (const [phrase, mask] of table) {
      const key = tokenize(phrase).join(' ')
      merged.set(key, (merged.get(key) ?? 0) | mask)
    }
  }
  return [...merged.entries()].map(([key, mask]) => ({ tokens: key.split(' '), mask }))
}

const KEYWORD_INDEX: readonly IndexedKeyword[] = buildIndex([
  PORK_WORDS,
  SHELLFISH_WORDS,
  MEAT_WORDS,
  FISH_WORDS,
  DAIRY_WORDS,
  EGG_WORDS,
  HONEY_WORDS,
  HIDDEN_WORDS,
])

const EXEMPTION_INDEX: readonly IndexedKeyword[] = buildIndex([
  DAIRY_EXEMPTIONS.map((tokens): readonly [string, number] => [tokens.join(' '), DAIRY]),
  MEAT_EXEMPTIONS.map((tokens): readonly [string, number] => [tokens.join(' '), MEAT | HIDDEN]),
])

/** Contiguous subsequence match of `pattern` inside `tokens`. */
function matchesAt(tokens: readonly string[], offset: number, pattern: readonly string[]): boolean {
  if (offset + pattern.length > tokens.length) return false
  for (let i = 0; i < pattern.length; i += 1) {
    if (tokens[offset + i] !== pattern[i]) return false
  }
  return true
}

/**
 * Bitmask of ingredient groups present in `names`. DAIRY is suppressed
 * for plant milks/creams.
 */
export function ingredientGroups(names: readonly string[]): number {
  let groups = 0
  for (const name of names) {
    const tokens = tokenize(name)
    if (tokens.length === 0) continue
    let exempt = 0
    for (const { tokens: pattern, mask } of EXEMPTION_INDEX) {
      for (let i = 0; i + pattern.length <= tokens.length; i += 1) {
        if (matchesAt(tokens, i, pattern)) {
          exempt |= mask
          break
        }
      }
    }
    for (const { tokens: pattern, mask: keywordMask } of KEYWORD_INDEX) {
      let hit = false
      for (let i = 0; i + pattern.length <= tokens.length; i += 1) {
        if (matchesAt(tokens, i, pattern)) {
          hit = true
          break
        }
      }
      if (!hit) continue
      groups |= keywordMask & ~exempt
    }
  }
  return groups
}

/** True when the recipe's ingredient names violate `diet`. */
export function violatesDiet(names: readonly string[], diet: DietId): boolean {
  return (ingredientGroups(names) & DIET_FORBIDS[diet]) !== 0
}

/** True when the recipe satisfies `diet` (no forbidden ingredient). */
export function matchesDiet(names: readonly string[], diet: DietId): boolean {
  return !violatesDiet(names, diet)
}

/** Diet results for one recipe, keyed by rule. */
export type DietVerdict = Record<DietId, boolean>

/** All five verdicts from one pass over the ingredient names. */
export function classifyDiets(names: readonly string[]): DietVerdict {
  const groups = ingredientGroups(names)
  const verdict = {} as DietVerdict
  for (const id of DIET_IDS) verdict[id] = (groups & DIET_FORBIDS[id]) === 0
  return verdict
}

/* ---------- Catalog-level memo ---------- */

const verdictCache = new Map<number, DietVerdict>()

/**
 * Memoized verdict for a catalog entry. The snapshot is frozen, so one
 * classification per variant id is enough for the app's lifetime.
 */
export function dietVerdictFor(variantId: number, ingredientNames: readonly string[]): DietVerdict {
  const cached = verdictCache.get(variantId)
  if (cached) return cached
  const verdict = classifyDiets(ingredientNames)
  verdictCache.set(variantId, verdict)
  return verdict
}

/** Test seam: drop memoized verdicts (different catalog in tests). */
export function resetDietVerdictCache(): void {
  verdictCache.clear()
  indexCache = null
}

/** Catalog-wide verdicts + per-diet match counts (ADR-0018). */
export interface DietIndex {
  verdictById: Map<number, DietVerdict>
  /** Recipes passing each rule — the number shown on the chip. */
  counts: Record<DietId, number>
}

let indexCache: DietIndex | null = null

/**
 * Classify the whole catalog once (~120 ms for 2,730 recipes) and memoize
 * it: the snapshot is frozen, so the counts and verdicts never change for
 * the lifetime of the app.
 */
export function dietIndexFor(
  metas: ReadonlyArray<{ id: number; ingredient_names: readonly string[] }>,
): DietIndex {
  if (indexCache) return indexCache
  const verdictById = new Map<number, DietVerdict>()
  const counts = {} as Record<DietId, number>
  for (const id of DIET_IDS) counts[id] = 0
  for (const meta of metas) {
    const verdict = classifyDiets(meta.ingredient_names)
    verdictById.set(meta.id, verdict)
    for (const id of DIET_IDS) if (verdict[id]) counts[id] += 1
  }
  indexCache = { verdictById, counts }
  return indexCache
}

/**
 * Recipes passing a diet, memoized per (variant, diet) at the store level.
 * `dietFilter` multi-selects are an AND (intersection).
 */
export function matchesAllDiets(verdict: DietVerdict, diets: readonly DietId[]): boolean {
  return diets.every((d) => verdict[d])
}

/** Chip label with its match count, e.g. `No-pork (1,842)`. */
export function dietChipLabel(diet: DietId, count: number): string {
  return `${DIET_LABELS[diet]} (${count.toLocaleString('en-US')})`
}
