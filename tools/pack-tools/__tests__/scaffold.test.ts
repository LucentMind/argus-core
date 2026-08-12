import { describe, it, expect } from 'vitest'
import { PACK_API_VERSION } from '../../../app/src/main/services/packs/manifest'

describe('pack-tools scaffold', () => {
  // Asserts the SHAPE, not the literal. A pinned value here is a second place to bump on every
  // pack-API change, and CI runs only from app/ — so the stale pin fails in nobody's face until
  // someone runs this package's tests by hand (which is how the 1 → '1.1.0' bump slipped through).
  // app/src/main/services/packs/__tests__/manifest.test.ts owns the exact-value assertion.
  it('can import the shared manifest schema from app (single source of truth)', () => {
    expect(typeof PACK_API_VERSION).toBe('string')
    expect(PACK_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
