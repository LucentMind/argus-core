import { describe, it, expect } from 'vitest'
import { buildDraftPrompt, buildImprovePrompt } from '../prompts'
import { draftAsset, improveAsset } from '../service'

describe('buildDraftPrompt', () => {
  it('names the target so generated frontmatter can match the folder', () => {
    const p = buildDraftPrompt({
      kind: 'skill',
      name: 'repro-gap',
      text: 'when a bug lacks repro steps'
    })
    expect(p).toContain('repro-gap')
    expect(p).toContain('when a bug lacks repro steps')
  })

  it('uses the skill contract for skills and the reference contract for references', () => {
    const skill = buildDraftPrompt({ kind: 'skill', name: 'a', text: 'x' })
    const reference = buildDraftPrompt({ kind: 'reference', name: 'a.md', text: 'x' })
    expect(skill).toContain('SKILL.md')
    expect(reference).not.toContain('SKILL.md')
  })

  it('honours a prompt-registry override', () => {
    const p = buildDraftPrompt({ kind: 'skill', name: 'a', text: 'x' }, (id) =>
      id === 'headless.authoring.skill-contract' ? 'OVERRIDDEN' : ''
    )
    expect(p).toContain('OVERRIDDEN')
  })
})

describe('buildImprovePrompt', () => {
  it('includes the current buffer and the target name', () => {
    const p = buildImprovePrompt({ kind: 'skill', name: 'rca', text: '---\nname: rca\n---\nbody' })
    expect(p).toContain('rca')
    expect(p).toContain('body')
  })
})

describe('draftAsset / improveAsset', () => {
  it('passes the built prompt to the runner and returns its raw output verbatim', async () => {
    const seen: string[] = []
    const run = async (prompt: string): Promise<string> => {
      seen.push(prompt)
      return '---\nname: x\n---\nout'
    }
    await expect(draftAsset({ kind: 'skill', name: 'x', text: 'y' }, run)).resolves.toBe(
      '---\nname: x\n---\nout'
    )
    await expect(improveAsset({ kind: 'skill', name: 'x', text: 'y' }, run)).resolves.toBe(
      '---\nname: x\n---\nout'
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})
