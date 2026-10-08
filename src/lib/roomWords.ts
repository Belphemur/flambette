/**
 * Three-word room codes (ADR-0021).
 *
 * A room code used to be 4–12 random alphanumerics read off one phone
 * and typed on the other. Three ordinary lowercase words ("amber-falcon-
 * lantern") are typed correctly on the first try, survive being read
 * aloud, and can be dictated — the failure mode of the old code was
 * never the relay, it was transcription.
 *
 * 64 words per list × 3 lists = 262,144 combinations. Collisions are
 * tolerated by design (see ADR-0021): the relay rejects a taken code and
 * the client simply rolls another, and a *wrong* code simply joins an
 * empty room, which the user re-rolls.
 *
 * Legacy 4–12 char alphanumeric codes remain valid input everywhere
 * (ADR-0019 households already have one persisted): the accepted format
 * is the UNION of both shapes.
 */

/** Curated, all lowercase ASCII, 3–10 letters, no sensitive terms. */
export const COLOR_WORDS: readonly string[] = [
  'amber', 'amethyst', 'azure', 'beige', 'black', 'blue', 'bronze', 'brown',
  'coral', 'cream', 'crimson', 'cyan', 'cobalt', 'blush', 'fawn', 'pewter',
  'sand', 'denim', 'emerald', 'fuchsia', 'garnet',
  'gold', 'green', 'indigo', 'ivory', 'jade', 'khaki', 'lilac', 'lime',
  'magenta', 'maroon', 'mauve', 'navy', 'ochre', 'olive', 'onyx', 'peach',
  'pearl', 'peridot', 'pink', 'plum', 'purple', 'quartz', 'red', 'rose',
  'ruby', 'russet', 'saffron', 'sapphire', 'scarlet', 'sepia', 'sienna', 'silver',
  'slate', 'tangerine', 'tan', 'teal', 'topaz', 'turquoise', 'umber', 'violet',
  'white', 'wine', 'yellow',
]

export const ANIMAL_WORDS: readonly string[] = [
  'badger', 'beaver', 'bison', 'camel', 'canary', 'catfish', 'chipmunk', 'cobra',
  'condor', 'cougar', 'crane', 'cricket', 'dingo', 'dolphin', 'donkey', 'dove',
  'duck', 'eagle', 'egret', 'elk', 'falcon', 'ferret', 'finch', 'flamingo',
  'gazelle', 'gecko', 'gerbil', 'giraffe', 'gopher', 'grouse', 'hamster', 'heron',
  'iguana', 'impala', 'jackal', 'jaguar', 'kestrel', 'lemur', 'leopard', 'lynx',
  'macaw', 'magpie', 'marmot', 'marten', 'mink', 'mole', 'mongoose', 'moose',
  'narwhal', 'newt', 'ocelot', 'opossum', 'orca', 'osprey', 'otter', 'owl',
  'panther', 'parrot', 'peacock', 'pelican', 'penguin', 'pigeon', 'puffin', 'puma',
  'rabbit', 'raccoon', 'raven', 'robin', 'sardine', 'seal', 'skunk', 'sloth',
  'sparrow', 'stoat', 'stork', 'swan', 'tapir', 'tern', 'toad', 'tortoise',
  'toucan', 'trout', 'tuna', 'turtle', 'vulture', 'walrus', 'weasel', 'whale',
  'wolf', 'wren', 'yak', 'zebra',
]

export const PLACE_WORDS: readonly string[] = [
  'anchor', 'apple', 'autumn', 'bakery', 'basket', 'beacon', 'bicycle', 'blanket',
  'blossom', 'bottle', 'boulder', 'bridge', 'cabin', 'candle', 'canyon', 'castle',
  'cavern', 'cedar', 'cliff', 'clover', 'copper', 'cottage', 'crater', 'crystal',
  'desert', 'diamond', 'engine', 'fountain', 'garden', 'glacier', 'hammock', 'harbor',
  'harvest', 'helmet', 'hollow', 'island', 'jacket', 'jungle', 'kettle', 'lantern',
  'ledger', 'magnet', 'marble', 'meadow', 'mirror', 'monsoon', 'mosaic', 'mountain',
  'nectar', 'orchard', 'palace', 'parcel', 'pebble', 'pillow', 'planet', 'plateau',
  'pocket', 'prism', 'pumpkin', 'quarry', 'ribbon', 'river', 'saddle', 'sequoia',
  'shelter', 'spring', 'sunset', 'temple', 'thunder', 'timber', 'tomato', 'tundra',
  'tunnel', 'valley', 'village', 'walnut', 'willow', 'window', 'winter', 'wonder',
]

/** The three word lists, in the order a code reads out. */
export const ROOM_WORD_LISTS: readonly (readonly string[])[] = [COLOR_WORDS, ANIMAL_WORDS, PLACE_WORDS]

/*
 * Display-name lists (ADR-0063): deliberately NOT the room-code lists, so
 * a person's name never reads like a room code. Same curation rules as the
 * code lists — lowercase ASCII, 3–10 letters — and disjoint from them (the
 * unit tests pin the disjointness), because "Brave Otter" joined to a
 * three-word code is one shared vocabulary too many.
 */

export const NAME_ADJECTIVES: readonly string[] = [
  'brave', 'bright', 'calm', 'cheery', 'clever', 'cozy', 'crisp', 'dapper',
  'dashing', 'eager', 'easygoing', 'fancy', 'festive', 'gentle', 'glad',
  'gleeful', 'golden', 'grand', 'happy', 'hardy', 'hearty', 'honeyed',
  'jolly', 'joyful', 'keen', 'kindly', 'lively', 'lucky', 'mellow', 'merry',
  'mighty', 'mild', 'minty', 'noble', 'nimble', 'honest', 'perky', 'peaceful',
  'peppery', 'playful', 'plucky', 'posh', 'prim', 'quick', 'quirky', 'radiant',
  'restful', 'rosy', 'rustic', 'sassy', 'serene', 'sharp', 'shiny', 'silky',
  'simple', 'smart', 'smooth', 'snappy', 'snazzy', 'spiffy', 'spicy',
  'sprightly', 'stellar', 'sunny', 'sweet', 'tidy', 'toasty', 'tranquil',
  'upbeat', 'valiant', 'vivid', 'warm', 'whimsical', 'witty', 'zesty', 'zen',
]

export const NAME_NOUNS: readonly string[] = [
  'apron', 'basil', 'batter', 'bayleaf', 'blender', 'bowl', 'brioche', 'brook',
  'cacao', 'cake', 'caramel', 'clove', 'cocoa', 'comet', 'croissant', 'crumble',
  'cumin', 'curry', 'custard', 'dandelion', 'dawn', 'dumpling', 'ember',
  'fennel', 'fern', 'fig', 'fluff', 'forest', 'gnocchi', 'granola', 'grove',
  'hazelnut', 'herb', 'honey', 'horizon', 'jam', 'juniper', 'kernel', 'kiwi',
  'latte', 'lemon', 'linden', 'loaf', 'maple', 'meringue', 'mocha', 'morsel',
  'muffin', 'noodle', 'nutmeg', 'oat', 'oatmeal', 'papaya', 'pancake', 'pastry',
  'peanut', 'pear', 'pesto', 'polenta', 'popsicle', 'pudding', 'radish',
  'raisin', 'recipe', 'relish', 'risotto', 'rosemary', 'sage', 'scone', 'sesame',
  'shortbread', 'simmer', 'skillet', 'snack', 'sorbet', 'sorrel', 'spoon',
  'sprinkle', 'steam', 'sugar', 'sundae', 'syrup', 'thyme', 'toaster', 'treacle',
  'tulip', 'vanilla', 'vine', 'whisk', 'zucchini',
]

/** 3–10 lowercase letters per word. */
const WORD_RE = /^[a-z]{3,10}$/

/** The current format: `amber-falcon-lantern`. */
export const WORD_ROOM_CODE_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/

/** The pre-ADR-0021 format, kept for backward compatibility (ADR-0019). */
export const LEGACY_ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/

/**
 * Join already-chosen words into a code. Words are lowercased and any
 * separator the caller used is normalized to a single hyphen.
 */
export function formatRoomCode(words: readonly string[]): string {
  return words.map((w) => w.trim().toLowerCase()).join('-')
}

/**
 * Uniform random index in [0, bound) — crypto.getRandomValues with
 * rejection sampling (no modulo bias), Math.random only as a fallback
 * for environments without it. The comment used to claim crypto while
 * calling Math.random (qodo 4128519648).
 */
function randomIndex(bound: number): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / bound) * bound
    const buf = new Uint32Array(1)
    do {
      crypto.getRandomValues(buf)
    } while (buf[0] >= limit)
    return buf[0] % bound
  }
  return Math.floor(Math.random() * bound)
}

/**
 * Roll a fresh code. Uses `crypto.getRandomValues` (via randomIndex) so
 * the words are not correlated with anything observable; `Math.random`
 * is a fallback (the code is a join key, not a secret — enumeration is
 * mitigated at the relay by create/join throttling).
 */
export function generateRoomCode(): string {
  const pick = <T>(list: readonly T[]): T => list[randomIndex(list.length)]
  return formatRoomCode(ROOM_WORD_LISTS.map(pick))
}

/**
 * Split a run-together token ("amberfalconlantern") back into three
 * words using the CURATED lists. A blind split at every offset would
 * invent words ("amb-erfal-conlantern"), so only splits whose parts are
 * all real list entries count — and an ambiguous token yields null.
 */
export function splitRunTogetherWordCode(token: string): string | null {
  if (token.length < 9 || token.length > 32) return null
  const matches = new Set<string>()
  for (const color of COLOR_WORDS) {
    if (!token.startsWith(color)) continue
    const rest = token.slice(color.length)
    for (const animal of ANIMAL_WORDS) {
      if (!rest.startsWith(animal)) continue
      const tail = rest.slice(animal.length)
      if (tail.length > 10) continue
      if (PLACE_WORDS.includes(tail)) matches.add(`${color}-${animal}-${tail}`)
    }
  }
  return matches.size === 1 ? [...matches][0] : null
}

/**
 * Normalize ANY accepted room-code input to its canonical form:
 * - `Amber Falcon-Lantern`, `amber_falcon lantern`, `amberfalconlantern`
 *   → `amber-falcon-lantern`
 * - a legacy `ZZ9ZZZ` (any case) → `ZZ9ZZZ` (upper, exactly as before)
 * Returns '' for anything else — callers treat '' as "not a code".
 *
 * A PARTIAL word code ("amber-falcon", "amber falcon lantern extra") is
 * never coerced into a legacy code: joining the wrong room is worse than
 * refusing the input.
 */
export function normalizeRoomCode(raw: string): string {
  const lower = raw.trim().toLowerCase()
  if (!lower) return ''
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length === 3) {
    return tokens.every((w) => WORD_RE.test(w)) ? tokens.join('-') : ''
  }
  if (tokens.length === 1) {
    const token = tokens[0]
    const runTogether = splitRunTogetherWordCode(token)
    if (runTogether) return runTogether
    // Legacy shape, upper-cased exactly as ADR-0019 stored it, so legacy
    // rooms are found under the same relay key they always had.
    return /^[a-z0-9]{4,12}$/.test(token) ? token.toUpperCase() : ''
  }
  return ''
}

/** True when `code` is ALREADY in canonical form (either shape). */
export function isRoomCode(code: string): boolean {
  return WORD_ROOM_CODE_RE.test(code) || LEGACY_ROOM_CODE_RE.test(code)
}

/** True when the code is the new three-word format. */
export function isWordRoomCode(code: string): boolean {
  return WORD_ROOM_CODE_RE.test(code)
}

/**
 * A generated display name, shown Title Case (ADR-0063): `<adjective> <noun>`
 * — "Brave Otter". The name is stored exactly as returned (displayed,
 * wire-carried and avatar-hashed from the same string), so there is one
 * spelling of a person everywhere. Name conflicts are fine: the roster
 * disambiguates by pattern and context, never by forced uniqueness.
 */
export function generateDisplayName(): string {
  const adj = NAME_ADJECTIVES[randomIndex(NAME_ADJECTIVES.length)]
  const noun = NAME_NOUNS[randomIndex(NAME_NOUNS.length)]
  return titleCaseName(`${adj} ${noun}`)
}

/** "brave otter" → "Brave Otter" (the generated names' display form). */
export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Guard for the curated word lists (used by the unit tests): every word
 * is lowercase ASCII, 3–10 letters, and no list repeats a word.
 */
export function wordListProblem(list: readonly string[]): string | null {
  if (list.length < 64) return `list has only ${list.length} words (need 64+)`
  if (new Set(list).size !== list.length) return 'list repeats a word'
  const bad = list.filter((w) => !WORD_RE.test(w))
  if (bad.length) return `words not lowercase ASCII 3-10 letters: ${bad.join(', ')}`
  return null
}
