import { describe, it, expect } from 'vitest'
import { partitionIssues, countBySeverity, summariseIssues, type DocLines } from '../diagnostics'
import type { ValidationIssue } from '../../../../shared/assetValidation'

/** Stands in for CodeMirror's `Text`, which satisfies `DocLines` structurally. Keeping the test
 *  on a fake is the point: this module must be provable without a DOM or a CodeMirror state. */
function fakeDoc(text: string): DocLines {
  const lines = text.split('\n')
  return {
    lines: lines.length,
    line(n) {
      if (n < 1 || n > lines.length) throw new RangeError(`Invalid line number ${n}`)
      let from = 0
      for (let i = 0; i < n - 1; i++) from += lines[i].length + 1
      return { from, to: from + lines[n - 1].length }
    }
  }
}

const doc = fakeDoc('alpha\nbravo\ncharlie')

describe('partitionIssues', () => {
  it('widens a line-only issue to the whole line', () => {
    const issues: ValidationIssue[] = [{ severity: 'error', message: 'boom', line: 2 }]
    expect(partitionIssues(issues, doc)).toEqual({
      placed: [{ from: 6, to: 11, severity: 'error', message: 'boom' }],
      unplaced: []
    })
  })

  it('sends an issue with no line to unplaced, never to line 1', () => {
    const issues: ValidationIssue[] = [{ severity: 'error', message: 'no body' }]
    const { placed, unplaced } = partitionIssues(issues, doc)
    expect(placed).toEqual([])
    expect(unplaced).toEqual([{ severity: 'error', message: 'no body' }])
  })

  it('clamps a line past the end of the document instead of throwing', () => {
    const issues: ValidationIssue[] = [{ severity: 'warning', message: 'late', line: 99 }]
    expect(partitionIssues(issues, doc).placed).toEqual([
      { from: 12, to: 19, severity: 'warning', message: 'late' }
    ])
  })

  it('clamps a zero or negative line to the first line', () => {
    const issues: ValidationIssue[] = [{ severity: 'error', message: 'early', line: 0 }]
    expect(partitionIssues(issues, doc).placed).toEqual([
      { from: 0, to: 5, severity: 'error', message: 'early' }
    ])
  })

  it('places a point diagnostic on an empty line', () => {
    const issues: ValidationIssue[] = [{ severity: 'warning', message: 'blank', line: 2 }]
    expect(partitionIssues(issues, fakeDoc('a\n\nb')).placed).toEqual([
      { from: 2, to: 2, severity: 'warning', message: 'blank' }
    ])
  })

  it('preserves issue order across both buckets', () => {
    const issues: ValidationIssue[] = [
      { severity: 'error', message: 'a', line: 1 },
      { severity: 'warning', message: 'b' },
      { severity: 'error', message: 'c', line: 3 }
    ]
    const { placed, unplaced } = partitionIssues(issues, doc)
    expect(placed.map((p) => p.message)).toEqual(['a', 'c'])
    expect(unplaced.map((u) => u.message)).toEqual(['b'])
  })
})

describe('countBySeverity', () => {
  it('counts each severity', () => {
    expect(
      countBySeverity([
        { severity: 'error', message: 'a' },
        { severity: 'warning', message: 'b' },
        { severity: 'warning', message: 'c' }
      ])
    ).toEqual({ errors: 1, warnings: 2 })
  })

  it('returns zeroes for an empty list', () => {
    expect(countBySeverity([])).toEqual({ errors: 0, warnings: 0 })
  })
})

describe('summariseIssues', () => {
  it('names both severities when both are present', () => {
    expect(
      summariseIssues([
        { severity: 'error', message: 'a' },
        { severity: 'warning', message: 'b' },
        { severity: 'warning', message: 'c' }
      ])
    ).toBe('1 error, 2 warnings')
  })

  it('singularises', () => {
    expect(summariseIssues([{ severity: 'error', message: 'a' }])).toBe('1 error')
    expect(summariseIssues([{ severity: 'warning', message: 'a' }])).toBe('1 warning')
  })

  it('omits a severity with no issues rather than saying "0 warnings"', () => {
    expect(
      summariseIssues([
        { severity: 'error', message: 'a' },
        { severity: 'error', message: 'b' }
      ])
    ).toBe('2 errors')
  })

  it('returns an empty string for a clean file', () => {
    expect(summariseIssues([])).toBe('')
  })
})
