// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findTextRanges } from '../findHighlight'

function root(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('findTextRanges', () => {
  it('finds every case-insensitive occurrence, across paragraphs', () => {
    const el = root('<p>Brake failed. The BRAKE pad</p><p>no brake here? yes brake</p>')
    const ranges = findTextRanges(el, 'brake')
    expect(ranges.map((r) => r.toString())).toEqual(['Brake', 'BRAKE', 'brake', 'brake'])
  })

  it('matches across inline markup boundaries', () => {
    const el = root('<p>the brake <strong>pad wear</strong> is high</p>')
    const ranges = findTextRanges(el, 'brake pad')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('brake pad')
  })

  it('returns nothing for a blank or absent query', () => {
    const el = root('<p>hello</p>')
    expect(findTextRanges(el, '  ')).toEqual([])
    expect(findTextRanges(el, 'zzz')).toEqual([])
  })

  it('does not overlap repeated-character matches', () => {
    const el = root('<p>aaaa</p>')
    expect(findTextRanges(el, 'aa')).toHaveLength(2)
  })
})
