/**
 * Build the pre-built search index (ADR-0060).
 *
 * Reads `public/data/builder_data.json`, builds the MiniSearch index with the
 * EXACT options `src/lib/search.ts` uses (imported, not copied — single source
 * of truth), and writes `public/data/search_index.json` (MiniSearch `toJSON`
 * format).
 *
 * Usage:
 *   bun scripts/build_search_index.ts       — build and write the index
 *   bun scripts/build_search_index.ts --check — exit 1 on drift from committed file
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import MiniSearch from 'minisearch'
import { buildCatalog, parseUserRecipes } from '../src/lib/catalog'
import { buildSearchDoc, INDEX_OPTIONS } from '../src/lib/search'
import type { VariantMeta } from '../src/lib/types'
import type { BuilderData } from '../src/lib/types'
import type { SearchDoc } from '../src/lib/search'

const BASE = 'public/data'

function loadBuilderData(): BuilderData {
  const raw = readFileSync(`${BASE}/builder_data.json`, 'utf8')
  return JSON.parse(raw) as BuilderData
}

function loadUserRecipes(): import('../src/lib/catalog').UserRecipeEntry[] {
  const path = `${BASE}/user_recipes.json`
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return parseUserRecipes(raw)
  } catch {
    console.warn('[build_search_index] user_recipes.json parse failed; continuing without it')
    return []
  }
}

function buildIndex(data: BuilderData, users: import('../src/lib/catalog').UserRecipeEntry[]): MiniSearch<SearchDoc> {
  const catalog = buildCatalog(data, users)
  const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS)
  index.addAll(catalog.variantMeta.map((meta: VariantMeta) => buildSearchDoc(meta)))
  return index
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if ((a as unknown[]).length !== (b as unknown[]).length) return false
    for (let i = 0; i < (a as unknown[]).length; i++) {
      if (!deepEqual((a as unknown[])[i], (b as unknown[])[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj).sort()
  const bKeys = Object.keys(bObj).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false
    if (!deepEqual(aObj[aKeys[i]!], bObj[bKeys[i]!])) return false
  }
  return true
}

function checkDrift(index: MiniSearch<SearchDoc>): boolean {
  const committed = JSON.parse(readFileSync(`${BASE}/search_index.json`, 'utf8'))
  const inMemory = index.toJSON()
  return deepEqual(inMemory, committed)
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const data = loadBuilderData()
  const users = loadUserRecipes()
  const index = buildIndex(data, users)

  if (checkOnly) {
    if (checkDrift(index)) {
      console.log('search index: OK (no drift)')
      process.exit(0)
    } else {
      console.error('search index: DRIFT detected — run "bun run data:search"')
      process.exit(1)
    }
  }

  const json = JSON.stringify(index.toJSON())
  writeFileSync(`${BASE}/search_index.json`, json)
  console.log(`search index: wrote ${BASE}/search_index.json (${(json.length / 1024).toFixed(0)} KB) with ${users.length} user recipe(s)`)
}

main()
