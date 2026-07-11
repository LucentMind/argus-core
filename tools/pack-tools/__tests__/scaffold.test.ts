import { describe, it, expect } from 'vitest'
import { PACKAGER_READY } from '../src/build'
import { PACK_API_VERSION } from '../../../app/src/main/services/packs/manifest'

describe('pack-tools scaffold', () => {
  it('loads its own module', () => {
    expect(PACKAGER_READY).toBe(true)
  })
  it('can import the shared manifest schema from app (single source of truth)', () => {
    expect(PACK_API_VERSION).toBe(1)
  })
})
