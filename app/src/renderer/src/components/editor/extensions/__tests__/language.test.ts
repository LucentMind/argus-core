import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { assetLanguage } from '../language'

/** Node names from the root down, in document order, capped so a failure prints something
 *  readable rather than a whole tree. */
function nodeNames(doc: string, limit = 6): string[] {
  const state = EditorState.create({ doc, extensions: [assetLanguage()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  if (!tree) throw new Error('the parse did not finish inside the timeout')
  const names: string[] = []
  tree.iterate({
    enter(node) {
      if (names.length < limit) names.push(node.name)
    }
  })
  return names
}

describe('assetLanguage', () => {
  it('parses a YAML frontmatter block above a markdown body', () => {
    const names = nodeNames('---\nname: my-skill\ndescription: does things\n---\n\n# Title\n')
    expect(names.slice(0, 3)).toEqual(['Document', 'Frontmatter', 'DashLine'])
    expect(names).toContain('BlockMapping')
  })

  it('parses frontmatter with CRLF line endings', () => {
    // Bundled skills are CRLF on Windows (see lineDiff.ts for the same hazard), and this is the
    // project's primary platform. A frontmatter helper that only recognises LF would leave every
    // bundled skill highlighted as plain markdown, header and all.
    const names = nodeNames('---\r\nname: x\r\n---\r\n\r\n# T\r\n')
    expect(names.slice(0, 3)).toEqual(['Document', 'Frontmatter', 'DashLine'])
  })

  it('falls back to plain markdown when there is no frontmatter fence', () => {
    // References have no frontmatter at all, so this is the common case for half the assets.
    const names = nodeNames('# Just markdown\n\ntext\n')
    expect(names).toContain('ATXHeading1')
    expect(names).not.toContain('Frontmatter')
  })

  it('parses an empty document without throwing', () => {
    expect(() => nodeNames('')).not.toThrow()
  })
})
