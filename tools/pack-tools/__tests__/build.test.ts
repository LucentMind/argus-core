import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { readManifest } from '../src/build'

const FIX = path.join(__dirname, 'fixtures')
const SAMPLE = path.join(FIX, 'sample-pack')

describe('readManifest', () => {
  it('reads and validates the sample manifest', () => {
    const m = readManifest(SAMPLE)
    expect(m.id).toBe('sample')
    expect(m.binaries[0].id).toBe('argus-demo')
  })

  it('throws when the manifest is missing', () => {
    expect(() => readManifest(FIX)).toThrow(/argus-pack\.json/)
  })
})
