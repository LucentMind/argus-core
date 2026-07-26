import { describe, it, expect } from 'vitest'
import { devToolsEnabled } from '../gate'

describe('devToolsEnabled', () => {
  it('is on in a dev run regardless of env', () => {
    expect(devToolsEnabled({ isDev: true, env: {} })).toBe(true)
  })

  it('is off in a packaged run with no override', () => {
    expect(devToolsEnabled({ isDev: false, env: {} })).toBe(false)
  })

  it('is on in a packaged run when ARGUS_DEV_TOOLS=1', () => {
    expect(devToolsEnabled({ isDev: false, env: { ARGUS_DEV_TOOLS: '1' } })).toBe(true)
  })

  it('requires exactly "1" — other truthy strings do not enable it', () => {
    expect(devToolsEnabled({ isDev: false, env: { ARGUS_DEV_TOOLS: 'true' } })).toBe(false)
    expect(devToolsEnabled({ isDev: false, env: { ARGUS_DEV_TOOLS: '0' } })).toBe(false)
    expect(devToolsEnabled({ isDev: false, env: { ARGUS_DEV_TOOLS: '' } })).toBe(false)
  })
})
