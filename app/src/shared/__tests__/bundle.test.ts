import { describe, it, expect } from 'vitest'
import { BUNDLE_FORMAT, bundleManifestSchema, bundleRowsSchema } from '../bundle'

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

describe('bundleRowsSchema', () => {
  it('parses a pre-existing rows.json with no sessions key and turns missing the rewind/fork fields', () => {
    // The shape every rows.json written before rewind/fork existed actually has: no `sessions`
    // array at all, and turns with none of model/rewoundAt/rewoundToTurnId/providerAnchorId.
    // A restore of an old archive bundle must not fail to parse just because those fields (and
    // the whole sessions array) are absent.
    const rows = bundleRowsSchema.parse({
      turns: [
        {
          id: 1,
          sessionId: 1,
          turnIndex: 0,
          status: 'done',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      toolCalls: [],
      evidence: [],
      findingPointers: []
    })
    expect(rows.sessions).toEqual([])
    expect(rows.turns[0]).toMatchObject({
      model: null,
      rewoundAt: null,
      rewoundToTurnId: null,
      providerAnchorId: null
    })
  })
})
