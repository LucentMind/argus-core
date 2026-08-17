import { describe, it, expect } from 'vitest'
import { applyPatch } from '../patch'

const SKILL = `---
name: diagnose-x
description: when X freezes
---
# diagnose-x

## Trigger
freeze

## Steps
1. look

## Notes
n
`

describe('applyPatch', () => {
  it('append-section adds content at the end of the section (before the next heading of same or higher level)', () => {
    const r = applyPatch(SKILL, [{ op: 'append-section', heading: '## Steps', content: '2. poke' }])
    expect(r.ok && r.text).toContain('## Steps\n1. look\n2. poke\n\n## Notes')
  })
  it('replace-section replaces the body, keeps the heading', () => {
    const r = applyPatch(SKILL, [{ op: 'replace-section', heading: '## Steps', content: 'A\nB' }])
    expect(r.ok && r.text).toContain('## Steps\nA\nB\n\n## Notes')
    expect(r.ok && r.text).not.toContain('1. look')
  })
  it('insert-after inserts a new block right after the section', () => {
    const r = applyPatch(SKILL, [
      { op: 'insert-after', heading: '## Trigger', content: '## Also\nx' }
    ])
    expect(r.ok && r.text).toMatch(/## Trigger\nfreeze\n\n## Also\nx\n\n## Steps/)
  })
  it('append-file appends at the end', () => {
    const r = applyPatch(SKILL, [{ op: 'append-file', content: '## Tail\nt' }])
    expect(r.ok && r.text.trimEnd().endsWith('## Tail\nt')).toBe(true)
  })
  it('frontmatter description is replaced, other keys untouched', () => {
    const r = applyPatch(SKILL, [], { description: 'when X or Y freezes' })
    expect(r.ok && r.text).toContain('name: diagnose-x\ndescription: when X or Y freezes\n---')
  })
  it('unknown heading fails', () => {
    const r = applyPatch(SKILL, [{ op: 'append-section', heading: '## Nope', content: 'x' }])
    expect(r.ok).toBe(false)
  })
  it('missing heading on a section op fails; frontmatter on a file without one fails', () => {
    expect(applyPatch(SKILL, [{ op: 'append-section', content: 'x' }]).ok).toBe(false)
    expect(applyPatch('# no fm\nbody', [], { description: 'd' }).ok).toBe(false)
  })
  it('ops apply in order and are CRLF-safe', () => {
    const r = applyPatch(SKILL.replace(/\n/g, '\r\n'), [
      { op: 'append-section', heading: '## Notes', content: 'm' }
    ])
    expect(r.ok && r.text).toContain('## Notes\nn\nm')
  })

  it('does not treat a "#"-prefixed line inside a fenced code block as a heading', () => {
    const SKILL_FENCE = `---
name: diagnose-x
description: when X freezes
---
# diagnose-x

## Steps
1. look
\`\`\`bash
# comment
echo hi
\`\`\`
2. poke

## Notes
n
`
    const r = applyPatch(SKILL_FENCE, [
      { op: 'append-section', heading: '## Steps', content: '3. done' }
    ])
    expect(r.ok).toBe(true)
    expect(r.ok && r.text).toContain('```bash\n# comment\necho hi\n```')
    expect(r.ok && r.text).toContain('2. poke\n3. done\n\n## Notes')
  })

  it('append-section inserts a blank line before an immediately-following heading', () => {
    const r = applyPatch('## Steps\n## Notes\nn\n', [
      { op: 'append-section', heading: '## Steps', content: 'X' }
    ])
    expect(r.ok && r.text).toContain('## Steps\nX\n\n## Notes')
  })

  it('insert-after adds one blank line on each side even with no trailing blank before the next heading', () => {
    const r = applyPatch('## Trigger\nfreeze\n## Steps\n1. look\n', [
      { op: 'insert-after', heading: '## Trigger', content: '## Also\nx' }
    ])
    expect(r.ok && r.text).toContain('freeze\n\n## Also\nx\n\n## Steps')
  })

  it('an unterminated fence in the document fails instead of silently deleting later sections', () => {
    const r = applyPatch('## A\n```\ntext\n## B\ncontent-b\n', [
      { op: 'replace-section', heading: '## A', content: 'new body' }
    ])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/fence/)
  })

  it('an unterminated fence in op content fails instead of corrupting the file', () => {
    const r = applyPatch(SKILL, [
      { op: 'append-section', heading: '## Steps', content: '```bash\necho hi' }
    ])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/fence/)
  })
})
