import { describe, it, expect } from 'vitest'
import { ROVO_FORM_EXTRAS } from '../connectors'

describe('ROVO_FORM_EXTRAS', () => {
  it('apiToken help says optional and mentions Confluence reference-sync', () => {
    expect(ROVO_FORM_EXTRAS.apiToken.help).toMatch(/optional/i)
    expect(ROVO_FORM_EXTRAS.apiToken.help).toMatch(/reference.?sync|confluence/i)
  })
  it('siteUrl/email labels signal they are optional', () => {
    expect(ROVO_FORM_EXTRAS.siteUrl.label).toMatch(/optional|advanced/i)
    expect(ROVO_FORM_EXTRAS.email.label).toMatch(/optional|advanced/i)
  })
})
