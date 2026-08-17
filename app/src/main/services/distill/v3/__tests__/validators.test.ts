import { describe, it, expect } from 'vitest'
import { validateMaterialized, type ValidateResult } from '../validators'

const IDS = { slug: 'nav-freeze-2026', jiraKey: 'AB-123' }
const SKILL = `---\nname: diagnose-y\ndescription: when Y\n---\n# diagnose-y\n\n## Steps\n1. a\n2. b\n3. c\n`
const ok = (over: Record<string, unknown> = {}): ValidateResult =>
  validateMaterialized(
    {
      type: 'skill-new',
      target: 'diagnose-y',
      content: SKILL,
      basis: 'a real basis of twenty+ chars',
      wholeFileUsed: false,
      ...over
    },
    IDS
  )

describe('validateMaterialized', () => {
  it('accepts a valid new skill', () => expect(ok()).toEqual({ ok: true, flags: [] }))
  it('frontmatter: skill-new needs a fenced block, name = target, description', () => {
    expect(ok({ content: '# no fm' })).toEqual({ ok: false, reason: 'frontmatter' })
    expect(ok({ content: SKILL.replace('name: diagnose-y', 'name: other') })).toEqual({
      ok: false,
      reason: 'frontmatter'
    })
    expect(ok({ content: SKILL.replace('description: when Y', 'description:') })).toEqual({
      ok: false,
      reason: 'frontmatter'
    })
  })
  it('bad-name', () =>
    expect(ok({ target: 'has space' })).toEqual({ ok: false, reason: 'bad-name' }))
  it('case-identifiers: slug or jira key in the body', () => {
    expect(ok({ content: SKILL + '\nsee AB-123' })).toEqual({
      ok: false,
      reason: 'case-identifiers'
    })
    expect(ok({ content: SKILL + '\ncase nav-freeze-2026' })).toEqual({
      ok: false,
      reason: 'case-identifiers'
    })
  })
  it('steps-in-reference: ≥3 numbered lines in a reference', () => {
    expect(ok({ type: 'reference-edit', target: 'r', content: '# R\n1. a\n2. b\n3. c\n' })).toEqual(
      { ok: false, reason: 'steps-in-reference' }
    )
    expect(ok({ type: 'reference-edit', target: 'r', content: '# R\n1. a\n2. b\n' })).toEqual({
      ok: true,
      flags: []
    })
  })
  it('basis too short', () =>
    expect(ok({ basis: 'short' })).toEqual({ ok: false, reason: 'basis' }))
  it('broad-edit: drop when ops produced it, flag when whole_file was used', () => {
    const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const rewritten = 'totally\ndifferent\n'
    expect(
      ok({
        type: 'skill-edit',
        content: `---\nname: diagnose-y\ndescription: d\n---\n${rewritten}`,
        original: `---\nname: diagnose-y\ndescription: d\n---\n${original}`
      })
    ).toEqual({ ok: false, reason: 'broad-edit' })
    expect(
      ok({
        type: 'skill-edit',
        content: `---\nname: diagnose-y\ndescription: d\n---\n${rewritten}`,
        original: `---\nname: diagnose-y\ndescription: d\n---\n${original}`,
        wholeFileUsed: true
      })
    ).toEqual({ ok: true, flags: ['broad-edit'] })
  })
  it('a local edit is not broad', () => {
    const original = `---\nname: diagnose-y\ndescription: d\n---\n## A\nx\n\n## B\ny\n`
    expect(
      ok({ type: 'skill-edit', content: original.replace('x\n', 'x\nx2\n'), original })
    ).toEqual({ ok: true, flags: [] })
  })
})
