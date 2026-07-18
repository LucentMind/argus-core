import { describe, it, expect } from 'vitest'
import { viewerForFileNode } from '../fileRouting'
import { MAX_WHOLE_FILE_BYTES } from '../../../../shared/textdoc'

const big = MAX_WHOLE_FILE_BYTES + 1
const evidence = { id: 7, artifactType: 'text', derived: false } as const

describe('viewerForFileNode', () => {
  it('routes large text evidence to the indexed TextViewer', () => {
    expect(
      viewerForFileNode('NAV-1', {
        name: 'big.txt',
        relPath: 'evidence/big.txt',
        kind: 'file',
        size: big,
        evidence
      })
    ).toEqual({ kind: 'evidence', evidenceId: 7, focusStart: 1, focusEnd: 0 })
  })

  it('keeps small evidence files on FileViewer (markdown rendering preserved)', () => {
    expect(
      viewerForFileNode('NAV-1', {
        name: 'notes.md',
        relPath: 'evidence/notes.md',
        kind: 'file',
        size: 500,
        evidence
      })
    ).toEqual({ kind: 'file', slug: 'NAV-1', relPath: 'evidence/notes.md' })
  })

  it('keeps non-evidence case files on FileViewer regardless of size', () => {
    expect(
      viewerForFileNode('NAV-1', {
        name: 'findings.md',
        relPath: 'findings.md',
        kind: 'file',
        size: big
      })
    ).toEqual({ kind: 'file', slug: 'NAV-1', relPath: 'findings.md' })
  })
})
