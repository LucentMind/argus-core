import { describe, it, expect } from 'vitest'
import { parseDescription, hasEmptyDescriptionBlock } from '../skillFrontmatter'

describe('parseDescription — inline form', () => {
  it('reads a plain single-line description', () => {
    expect(parseDescription('name: x\ndescription: Use when a case asks about data.')).toBe(
      'Use when a case asks about data.'
    )
  })

  it('keeps a colon inside the value', () => {
    expect(parseDescription('description: Crash: SIGABRT in the worker')).toBe(
      'Crash: SIGABRT in the worker'
    )
  })

  it('does not capture the next key when the description line is empty', () => {
    // The `[ \t]*` (not `\s*`) guard this module already documents: an empty description
    // followed immediately by another key must stay empty, not swallow that key's line.
    expect(parseDescription('description:\nname: rca')).toBe('')
  })

  it('tolerates CRLF line endings', () => {
    expect(parseDescription('description: Use when X.\r\nname: x')).toBe('Use when X.')
  })
})

describe('parseDescription — folded and literal block scalars', () => {
  it('reads a folded (>) description from its continuation lines', () => {
    const fm = ['description: >', '  Use when a case asks how much data', '  was downloaded.'].join(
      '\n'
    )
    expect(parseDescription(fm)).toBe('Use when a case asks how much data was downloaded.')
  })

  it('collapses a literal (|) description to one line', () => {
    // Both block forms yield a single line. Every consumer is line-oriented — buildSkillIndex
    // emits one `- name: description` bullet per skill and joins on '\n', so a preserved hard
    // break would put the description's second line into that list as a bullet of its own,
    // attached to no skill, in every turn's system prompt.
    const fm = ['description: |', '  First line.', '  Second line.'].join('\n')
    expect(parseDescription(fm)).toBe('First line. Second line.')
  })

  it('keeps both paragraphs when a blank line separates them', () => {
    // A blank line is not indented, so ending the block at the first non-indented line dropped
    // everything after it — the same silent half-empty description this change exists to fix.
    const fm = ['description: >', '  Para one.', '', '  Para two.', 'name: x'].join('\n')
    expect(parseDescription(fm)).toBe('Para one. Para two.')
    expect(parseDescription(['description: |', '  One.', '', '  Two.'].join('\n'))).toBe(
      'One. Two.'
    )
  })

  it('accepts the strip-chomping indicators >- and |-', () => {
    expect(parseDescription('description: >-\n  Folded and chomped.')).toBe('Folded and chomped.')
    expect(parseDescription('description: |-\n  Literal and chomped.')).toBe('Literal and chomped.')
  })

  it('stops at the next top-level key', () => {
    const fm = [
      'description: >',
      '  Use when a case asks about data.',
      'name: rca',
      'origin: proposal'
    ].join('\n')
    expect(parseDescription(fm)).toBe('Use when a case asks about data.')
  })

  it('stops at a following block key rather than absorbing its list items', () => {
    const fm = [
      'description: >',
      '  Use when a case asks about data.',
      'contributors:',
      '  - A. Author <author@example.com> 2026-08-05'
    ].join('\n')
    expect(parseDescription(fm)).toBe('Use when a case asks about data.')
  })

  it('returns empty for a block indicator with no continuation lines', () => {
    // The regression this whole change exists to prevent: a bare ">" is not a description,
    // and must read as empty so validateSkill's untriggerable-skill error fires.
    expect(parseDescription('description: >\nname: x')).toBe('')
    expect(parseDescription('description: |')).toBe('')
  })

  it('never returns a bare block indicator', () => {
    for (const ind of ['>', '>-', '|', '|-']) {
      expect(parseDescription(`description: ${ind}\n  Real text.`)).toBe('Real text.')
      expect(parseDescription(`description: ${ind}`)).toBe('')
    }
  })

  it('tolerates CRLF inside a folded block', () => {
    expect(parseDescription('description: >\r\n  Use when X.\r\n  And Y.\r\nname: x')).toBe(
      'Use when X. And Y.'
    )
  })
})

describe('hasEmptyDescriptionBlock', () => {
  it('is true for a block indicator with no indented body', () => {
    expect(hasEmptyDescriptionBlock('description: >\nname: x')).toBe(true)
    expect(hasEmptyDescriptionBlock('description: |-')).toBe(true)
  })

  it('is false when the block has a body', () => {
    expect(hasEmptyDescriptionBlock('description: >\n  Real text.')).toBe(false)
  })

  it('is false when the body opens with a blank line', () => {
    // Blank lines are part of the block now, so an emptiness test that counts them would fire
    // the untriggerable-skill error on a file whose description is right there.
    expect(hasEmptyDescriptionBlock('description: >\n\n  Real text.')).toBe(false)
  })

  it('is true for a block whose only continuation lines are blank', () => {
    expect(hasEmptyDescriptionBlock('description: >\n\n\nname: x')).toBe(true)
  })

  it('is false for an inline description, an empty one, and a missing one', () => {
    expect(hasEmptyDescriptionBlock('description: Use when X.')).toBe(false)
    expect(hasEmptyDescriptionBlock('description:\nname: x')).toBe(false)
    expect(hasEmptyDescriptionBlock('name: x')).toBe(false)
    expect(hasEmptyDescriptionBlock(null)).toBe(false)
  })
})
