import { describe, it, expect } from 'vitest'
import { PACK_API_VERSION } from '../../../app/src/main/services/packs/manifest'

describe('pack-tools scaffold', () => {
  it('can import the shared manifest schema from app (single source of truth)', () => {
    expect(PACK_API_VERSION).toBe(1)
  })
})
