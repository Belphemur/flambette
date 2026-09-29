/**
 * Parity harness: does scripts/build_pack_index.py (Python) agree with the
 * TypeScript it claims to mirror? Run with:
 *   bun run scripts/verify_pack_index_parity.ts
 *
 * Exits non-zero on any divergence, so CI can gate the Python builder against
 * src/lib/containers.ts + src/lib/quantity.ts drift.
 */
import { readFileSync } from 'node:fs'
import { parseContainerQuantity, containerKey } from '../src/lib/containers'
import { parseQuantity } from '../src/lib/quantity'

const BASE = 'public/data'

function nameKeyTs(name: string): string {
  let s = name.trim().toLowerCase()
  if (s.length > 3 && s.endsWith('oes')) s = s.slice(0, -2)
  else if (s.length > 4 && /^(ses|xes|zes|ches|shes)$/.test(s.slice(-4))) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1)
  return s
}

function unitKeyTs(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.length > 3 && u.endsWith('es')) return u.slice(0, -2)
  if (u.length > 2 && u.endsWith('s')) return u.slice(0, -1)
  return u
}

const index = JSON.parse(readFileSync(`${BASE}/pack_index.json`, 'utf8'))
const builder = JSON.parse(readFileSync(`${BASE}/builder_data.json`, 'utf8'))
const keys: string[] = index.ingredientKeys
const units: string[] = index.unitKeys

let containerMismatches = 0
let amountMismatches = 0
let examples: string[] = []

for (const vid of builder.feasible_variants) {
  const doc = JSON.parse(readFileSync(`${BASE}/recipes/${vid}.json`, 'utf8'))
  const rows = index.recipes[String(vid)]?.i
  if (!rows) {
    console.error(`missing index row for ${vid}`)
    process.exit(1)
  }
  const lines = doc.line_items || []
  if (lines.length !== rows.length) {
    console.error(`${vid}: line count ${lines.length} != index ${rows.length}`)
    process.exit(1)
  }
  // Index rows are emitted sorted by nameKey; recipe docs are in source
  // order. Compare name-keyed, not positionally.
  const byKey = new Map(rows.map(([k, a, u, c]: number[]) => [keys[k], { a, u: units[u], c }]))
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    const row = byKey.get(nameKeyTs(li.ingredient_name))
    if (!row) {
      console.error(`${vid}: no index row for ${li.ingredient_name}`)
      process.exit(1)
    }
    const { a, u, c } = row

    // nameKey parity is implied by the byKey lookup above: a key that does not
    // match on BOTH sides cannot be found here, so it would exit(1).

    const cont = parseContainerQuantity(li.quantity || '')
    const tsIsContainer = cont !== null
    if (tsIsContainer !== (c === 1)) {
      containerMismatches++
      if (examples.length < 5)
        examples.push(
          `container ${vid}#${i} "${li.ingredient_name}" qty="${li.quantity}": py=c${c} ts=${tsIsContainer}`,
        )
    }
    if (tsIsContainer && cont && u !== containerKey(cont.container, cont.annotation)) {
      containerMismatches++
      if (examples.length < 5)
        examples.push(`containerKey ${vid}#${i}: py="${u}" ts="${containerKey(cont.container, cont.annotation)}"`)
    }

    // amount: containers take the container amount; otherwise the linear amount
    const parsed = parseQuantity(li.quantity || '')
    const tsAmount = cont ? cont.amount : parsed ? parsed.amount : 0
    if (Math.abs(tsAmount - a) > 1e-3) {
      amountMismatches++
      if (examples.length < 5)
        examples.push(`amount ${vid}#${i} "${li.ingredient_name}" qty="${li.quantity}": py=${a} ts=${tsAmount}`)
    }
  }
}

console.log(`checked ${builder.feasible_variants.length} recipes x line items`)
console.log('nameKey parity:          implicit (a non-matching key exits above)')
console.log(`container mismatches:    ${containerMismatches}`)
console.log(`amount mismatches:       ${amountMismatches}`)
if (examples.length) {
  console.log('\nexamples:')
  for (const e of examples) console.log('  ' + e)
}
if (containerMismatches || amountMismatches) {
  console.log('\nPARITY FAILED — Python builder has drifted from src/lib/containers.ts')
  process.exit(1)
}
console.log('\nPARITY OK')
