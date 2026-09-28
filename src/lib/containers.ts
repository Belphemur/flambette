/**
 * Container-unit ("bundle") quantities — ADR-0017.
 *
 * A chunk of the frozen catalog phrases ingredients in the unit it is
 * actually *purchased* in: `1 head`, `½ (142 g) pkg`, `2 ½ cm pieces`,
 * `3 (398 ml) cans`, `1 small bunch`, `¾ (227 g) block`. Those units do
 * NOT behave like spoon measures: you cannot buy 1.7 pkg, you buy a whole
 * package. So container quantities are ceil-merged per
 * (container, annotation) instead of linearly scaled (ADR-0009 keeps its
 * linear rule for spoon/measure units).
 *
 * Everything here is pure and unit-tested; the aggregation boundary in
 * `grocery.ts` is the only caller.
 */

import { formatFraction, parseQuantity } from './quantity'

/** Size adjectives seen in front of a container noun in the catalog. */
const CONTAINER_ADJECTIVES: ReadonlySet<string> = new Set([
  'small',
  'medium',
  'large',
  'big',
  'jumbo',
  'mini',
  'extra-large',
])

/**
 * Purchasable container nouns (singular, canonical spelling). Deliberately
 * excludes count/measure nouns that are NOT containers: cloves, slices,
 * pieces, cups, stalks, sprigs, leaves.
 */
const CONTAINER_NOUNS: readonly string[] = [
  'pkg',
  'package',
  'bunch',
  'head',
  'can',
  'block',
  'bag',
  'jar',
  'log',
  'loaf',
  'bottle',
  'box',
  'tin',
  'carton',
  'ear',
  'stick',
  'crown',
  'heart',
  'cap',
]

const CONTAINER_NOUN_KEYS: ReadonlySet<string> = new Set(CONTAINER_NOUNS)

/** Canonical singular spelling per unitKey (e.g. `pkgs` → `pkg`). */
const CANONICAL_NOUN: ReadonlyMap<string, string> = new Map(
  CONTAINER_NOUNS.map((n) => [collapseUnit(n), n]),
)

/** Same naive singularization grocery.ts uses for unit merging. */
function collapseUnit(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.length > 3 && u.endsWith('es')) return u.slice(0, -2)
  if (u.length > 2 && u.endsWith('s')) return u.slice(0, -1)
  return u
}

export interface ContainerQuantity {
  /** Container count, fractional when the recipe says so (`½ (142 g) pkg` → 0.5). */
  count: number
  /** Container phrase without the annotation, first-seen spelling (`small bunches`). */
  container: string
  /** Leading parenthetical annotation kept verbatim (`(142 g)`), or ''. */
  annotation: string
  /** The raw quantity string as authored. */
  raw: string
}

/**
 * Split `½ (142 g) pkg` into count 0.5, annotation `(142 g)`, container
 * `pkg`. Returns null for anything that is not a purchasable container
 * unit (spoon measures, counts like `2 cloves`, unparseable text), which
 * the caller keeps on the linear-scaling path.
 */
export function parseContainerQuantity(raw: string): ContainerQuantity | null {
  const parsed = parseQuantity(raw)
  if (!parsed) return null
  if (!(parsed.amount > 0)) return null

  let rest = parsed.unit.trim()
  let annotation = ''
  const ann = rest.match(/^(\([^)]*\))\s*/)
  if (ann) {
    annotation = ann[1]
    rest = rest.slice(ann[0].length).trim()
  }
  if (!rest) return null

  const tokens = rest.split(/\s+/).filter(Boolean)
  const noun = tokens[tokens.length - 1]
  const adjectives = tokens.slice(0, -1)
  if (!CONTAINER_NOUN_KEYS.has(collapseUnit(noun))) return null
  if (adjectives.some((a) => !CONTAINER_ADJECTIVES.has(a.toLowerCase()))) return null

  return { count: parsed.amount, container: tokens.join(' '), annotation, raw: raw.trim() }
}

/** Merge key: two lines merge only when container AND annotation match. */
export function containerKey(container: string, annotation: string): string {
  return `${collapseUnit(container)}|${annotation}`
}

function pluralizeNoun(singular: string): string {
  if (/(ch|sh|s|x|z)$/.test(singular)) return `${singular}es`
  return `${singular}s`
}

/**
 * Render a container count. Integers print as integers (`1 (142 g) pkg`,
 * `2 (142 g) pkgs`); a summed remainder keeps its fraction
 * (`3/2 small bunch`). The annotation is preserved verbatim.
 */
export function formatContainerQuantity(amount: number, container: string, annotation: string): string {
  const tokens = container.split(/\s+/).filter(Boolean)
  const lastSeen = tokens.pop() ?? 'pkg'
  const adjectives = tokens.join(' ')
  const canonical = CANONICAL_NOUN.get(collapseUnit(lastSeen)) ?? collapseUnit(lastSeen)
  const noun = Math.abs(amount - Math.round(amount)) < 1e-9
    ? (Math.round(amount) === 1 ? canonical : pluralizeNoun(canonical))
    : pluralizeNoun(canonical)
  const head = formatFraction(amount)
  const parts = [head]
  if (annotation) parts.push(annotation)
  if (adjectives) parts.push(adjectives)
  parts.push(noun)
  return parts.join(' ')
}

/**
 * One recipe's contribution to the container total. Doubling servings does
 * NOT double the packages: a recipe for 6 using `½ small bunch` at 12
 * servings needs 1 whole bunch, not 1 (half-purchasable) bunch. At the
 * authored servings the authored count is kept verbatim so the grocery
 * line still reads like the recipe.
 */
export function containerContribution(count: number, factor: number): number {
  if (factor === 1) return count
  return Math.max(1, Math.ceil(count * factor - 1e-9))
}

/** True when a summed container amount is a whole number of containers. */
export function isWholeContainer(amount: number): boolean {
  return Math.abs(amount - Math.round(amount)) < 1e-9
}
