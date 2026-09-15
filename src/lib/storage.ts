/** Namespaced localStorage persistence shared by all stores. */

const KEY = 'mealime-planner:v1'

interface Persisted {
  [subkey: string]: unknown
}

function readRoot(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Persisted) : {}
  } catch {
    return {}
  }
}

export function load<T>(subkey: string, fallback: T): T {
  const root = readRoot()
  const value = root[subkey]
  return value === undefined ? fallback : (value as T)
}

export function save(subkey: string, value: unknown): void {
  const root = readRoot()
  root[subkey] = value
  try {
    localStorage.setItem(KEY, JSON.stringify(root))
  } catch {
    /* storage full or unavailable — app still works, just not persisted */
  }
}
