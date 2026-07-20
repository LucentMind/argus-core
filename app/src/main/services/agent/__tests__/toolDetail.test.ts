import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractToolDetail, type ToolDetailCtx } from '../toolDetail'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'

const REFS = path.join('/home/u/Argus', 'references')
const CASE = path.join('/home/u/Argus', 'cases', 'c1')
const ctx: ToolDetailCtx = { taxonomy: CLAUDE_TOOL_TAXONOMY, referencesDir: REFS, caseDir: CASE }

describe('extractToolDetail', () => {
  it('Skill: returns the name with the argus: plugin prefix stripped', () => {
    expect(extractToolDetail('Skill', { skill: 'argus:verify', args: 'x' }, ctx)).toBe('verify')
  })
  it('Skill: keeps foreign plugin prefixes verbatim (only argus: is ours)', () => {
    expect(extractToolDetail('Skill', { skill: 'superpowers:tdd' }, ctx)).toBe('superpowers:tdd')
  })
  it('Skill: non-string or blank skill → null', () => {
    expect(extractToolDetail('Skill', {}, ctx)).toBeNull()
    expect(extractToolDetail('Skill', { skill: '  ' }, ctx)).toBeNull()
    expect(extractToolDetail('Skill', { skill: 42 }, ctx)).toBeNull()
  })
  it('memory tools: returns the topic', () => {
    expect(extractToolDetail('mcp__argus__read_memory', { topic: 'nav-drift' }, ctx)).toBe('nav-drift')
    expect(extractToolDetail('mcp__argus__write_memory', { topic: 'tiles', content: 'x' }, ctx)).toBe('tiles')
    expect(extractToolDetail('mcp__argus__read_memory', {}, ctx)).toBeNull()
  })
  it('fs-read inside references root → ref:<relpath> with forward slashes', () => {
    const p = path.join(REFS, 'playbooks', 'triage.md')
    expect(extractToolDetail('Read', { file_path: p }, ctx)).toBe('ref:playbooks/triage.md')
  })
  it('fs-read of the references root itself, outside it, or via fs-write → null', () => {
    expect(extractToolDetail('Read', { file_path: REFS }, ctx)).toBeNull()
    expect(extractToolDetail('Read', { file_path: path.join(CASE, 'a.md') }, ctx)).toBeNull()
    expect(extractToolDetail('Write', { file_path: path.join(REFS, 'a.md') }, ctx)).toBeNull()
  })
  it('relative fs-read paths resolve against caseDir (never land in references by accident)', () => {
    expect(extractToolDetail('Read', { file_path: 'notes.md' }, ctx)).toBeNull()
  })
  it('works with a Copilot-shaped taxonomy (lowercase read tool)', () => {
    const cop: ToolDetailCtx = {
      ...ctx,
      taxonomy: { entries: { read: { kind: 'fs-read', pathFields: ['file_path'] } } }
    }
    expect(extractToolDetail('read', { file_path: path.join(REFS, 'x.md') }, cop)).toBe('ref:x.md')
  })
  it('unknown tools and taxonomy misses → null; never throws', () => {
    expect(extractToolDetail('TodoWrite', { whatever: 1 }, ctx)).toBeNull()
    expect(extractToolDetail('Bash', { command: 'cat x' }, ctx)).toBeNull()
  })
})
