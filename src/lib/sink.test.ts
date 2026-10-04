import { describe, expect, test } from 'bun:test'
import { sinkChecked } from './sink'

describe('sinkChecked', () => {
  const isHot = (row: { name: string; hot?: boolean }) => !!row.hot

  test('checked rows sink to the bottom, open rows keep their order', () => {
    const rows = [
      { name: 'a' },
      { name: 'b', hot: true },
      { name: 'c' },
      { name: 'd', hot: true },
      { name: 'e' },
    ]
    expect(sinkChecked(rows, isHot)).toEqual([
      { name: 'a' },
      { name: 'c' },
      { name: 'e' },
      { name: 'b', hot: true },
      { name: 'd', hot: true },
    ])
  })

  test('stable: checking a middle row keeps the others in relative order', () => {
    const rows = [{ name: 'first' }, { name: 'mid' }, { name: 'last' }]
    const out = sinkChecked(
      rows,
      (r) => r.name === 'mid',
    )
    expect(out.map((r) => r.name)).toEqual(['first', 'last', 'mid'])
  })

  test('already all checked: order is unchanged (stable all-done group)', () => {
    const rows = [{ name: 'x', hot: true }, { name: 'y', hot: true }, { name: 'z', hot: true }]
    const out = sinkChecked(rows, isHot)
    expect(out.map((r) => r.name)).toEqual(['x', 'y', 'z'])
  })

  test('none checked: order is unchanged and it is a copy', () => {
    const rows = [{ name: 'x' }, { name: 'y' }]
    const out = sinkChecked(rows, isHot)
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })

  test('empty input yields an empty array', () => {
    expect(sinkChecked([], isHot)).toEqual([])
  })

  test('does not mutate the input', () => {
    const rows = [{ name: 'a' }, { name: 'b', hot: true }, { name: 'c' }]
    const before = rows.map((r) => r.name)
    sinkChecked(rows, isHot)
    expect(rows.map((r) => r.name)).toEqual(before)
  })
})