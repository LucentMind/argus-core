import { describe, it, expect } from 'vitest'
import { queryTerms, renderSnippet } from '../snippet'

describe('queryTerms', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(queryTerms('  Connection   REFUSED ')).toEqual(['connection', 'refused'])
  })

  it('returns an empty array for a blank query', () => {
    expect(queryTerms('   ')).toEqual([])
  })
})

describe('renderSnippet', () => {
  it('wraps each matched term in guillemets', () => {
    expect(renderSnippet('the connection was refused by peer', 'connection refused')).toBe(
      'the «connection» was «refused» by peer'
    )
  })

  it('matches case-insensitively but preserves the original casing', () => {
    expect(renderSnippet('ERROR: Connection lost', 'connection')).toBe('ERROR: «Connection» lost')
  })

  it('merges overlapping matches instead of nesting markers', () => {
    expect(renderSnippet('abcdef', 'abc bcd')).toBe('«abcd»ef')
  })

  it('windows around the first match and marks both elisions', () => {
    const text = 'x'.repeat(500) + 'needle' + 'y'.repeat(500)
    const out = renderSnippet(text, 'needle', 60)
    expect(out).toContain('«needle»')
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    // 60 chars of window, plus the two markers and the two ellipses
    expect(out.length).toBeLessThanOrEqual(60 + 4)
  })

  it('does not prefix an ellipsis when the match is at the start', () => {
    const out = renderSnippet('needle' + 'y'.repeat(500), 'needle', 60)
    expect(out.startsWith('«needle»')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('falls back to the head of the text when no term is present', () => {
    expect(renderSnippet('nothing relevant here', 'absent', 10)).toBe('nothing re…')
  })

  it('returns an empty string for empty text', () => {
    expect(renderSnippet('', 'anything')).toBe('')
  })
})
