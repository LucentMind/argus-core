import { describe, it, expect } from 'vitest'
import { ROVO_FORM_EXTRAS } from '../connectors'

describe('ROVO_FORM_EXTRAS', () => {
  it('is empty — the Rovo card is Authorize-only now that REST runs OAuth-only (Part 3a)', () => {
    expect(ROVO_FORM_EXTRAS).toEqual({})
  })

  it('no longer carries apiToken/siteUrl/email keys', () => {
    const keys = Object.keys(ROVO_FORM_EXTRAS)
    expect(keys).not.toContain('apiToken')
    expect(keys).not.toContain('siteUrl')
    expect(keys).not.toContain('email')
  })
})
