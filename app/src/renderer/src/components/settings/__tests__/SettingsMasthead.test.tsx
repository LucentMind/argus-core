import { describe, it, expect } from 'vitest'
import { PAGES } from '../settingsPages'

describe('settings page metadata', () => {
  it('every page has a blurb', () => {
    for (const p of PAGES) {
      expect(p.blurb, `${p.id} has no blurb`).toBeTruthy()
      expect(p.blurb.length, `${p.id}'s blurb is too long for one line`).toBeLessThan(96)
    }
  })

  it('blurbs are sentences, not labels', () => {
    for (const p of PAGES) expect(p.blurb.endsWith('.'), `${p.id}`).toBe(true)
  })
})
