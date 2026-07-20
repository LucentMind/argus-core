import { describe, it, expect } from 'vitest'
import { nextView, type View } from '../viewReducer'

const HOME: View = { kind: 'home' }
const CASE: View = { kind: 'case', slug: 'NAV-1' }

describe('nextView', () => {
  it('Observability toggles shut on a second click, returning to prevView', () => {
    const prevView = CASE
    const cur: View = { kind: 'observability' }
    expect(nextView(cur, prevView, { kind: 'observability' })).toEqual(CASE)
  })

  it('Observability switches in from elsewhere on the first click', () => {
    expect(nextView(HOME, CASE, { kind: 'observability' })).toEqual({ kind: 'observability' })
  })

  it('Settings toggles shut on a second no-arg click, returning to prevView', () => {
    const prevView = CASE
    const cur: View = { kind: 'settings', page: 'general' }
    expect(nextView(cur, prevView, { kind: 'settings' })).toEqual(CASE)
  })

  it('Settings switches in from elsewhere on the first click', () => {
    expect(nextView(HOME, CASE, { kind: 'settings' })).toEqual({
      kind: 'settings',
      page: undefined
    })
  })

  it('carve-out: a deep link with a different page switches pages instead of closing', () => {
    const prevView = CASE
    const cur: View = { kind: 'settings', page: 'general' }
    // Even though we're already on Settings (which would normally toggle
    // shut), a `page` argument means this is a deep link -- it must land on
    // the requested page, not fall back to prevView.
    expect(nextView(cur, prevView, { kind: 'settings', page: 'memory' })).toEqual({
      kind: 'settings',
      page: 'memory'
    })
  })

  it('carve-out: a deep link to the page already showing stays put, not prevView', () => {
    const prevView = CASE
    const cur: View = { kind: 'settings', page: 'memory' }
    expect(nextView(cur, prevView, { kind: 'settings', page: 'memory' })).toEqual({
      kind: 'settings',
      page: 'memory'
    })
  })
})
