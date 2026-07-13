import { it, expect } from 'vitest'
import { citationsTray } from '../citationsTray'

it('accumulates, removes and clears chips per (case, session)', () => {
  citationsTray.clear('CASE-A', 1)
  let ticks = 0
  const off = citationsTray.subscribe(() => ticks++)
  citationsTray.add('CASE-A', 1, { relPath: 'evidence/a.txt', line: 3 })
  citationsTray.add('CASE-A', 1, { relPath: 'evidence/b.txt', line: 9 })
  citationsTray.add('CASE-A', 2, { relPath: 'evidence/c.txt', line: 1 })
  expect(citationsTray.get('CASE-A', 1)).toHaveLength(2)
  expect(citationsTray.get('CASE-A', 2)).toHaveLength(1)
  citationsTray.remove('CASE-A', 1, 0)
  expect(citationsTray.get('CASE-A', 1)).toEqual([{ relPath: 'evidence/b.txt', line: 9 }])
  citationsTray.clear('CASE-A', 1)
  expect(citationsTray.get('CASE-A', 1)).toEqual([])
  expect(ticks).toBeGreaterThan(0)
  off()
})
