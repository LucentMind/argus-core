import { describe, it, expect } from 'vitest'
import { BUNDLE_FORMAT, bundleManifestSchema } from '../bundle'

describe('bundleManifestSchema', () => {
  const valid = {
    format: 1,
    slug: 'NAV-100',
    title: 'Tile region fails',
    argusVersion: '1.0.0',
    createdAt: '2026-07-10T00:00:00.000Z',
    includesTranscripts: true,
    workspaces: [{ remote: 'https://github.com/org/repo.git', branch: 'main', commit: 'abc123' }],
    files: [{ path: 'case.json', sha256: 'deadbeef', size: 42 }]
  }

  it('parses a valid manifest and BUNDLE_FORMAT is 1', () => {
    expect(BUNDLE_FORMAT).toBe(1)
    const m = bundleManifestSchema.parse(valid)
    expect(m.slug).toBe('NAV-100')
    expect(m.files[0].path).toBe('case.json')
  })

  it('workspaces default to empty and unknown keys round-trip (looseObject)', () => {
    const m = bundleManifestSchema.parse({ ...valid, workspaces: undefined, futureKey: 'x' })
    expect(m.workspaces).toEqual([])
    expect((m as Record<string, unknown>).futureKey).toBe('x')
  })

  it('rejects a manifest without files', () => {
    expect(() => bundleManifestSchema.parse({ ...valid, files: undefined })).toThrow()
  })
})
