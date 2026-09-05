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
  it('case-identifiers: matches regardless of case', () => {
    expect(ok({ content: SKILL + '\nsee Nav-Freeze-2026' })).toEqual({
      ok: false,
      reason: 'case-identifiers'
    })
    expect(ok({ content: SKILL + '\ncase ab-123' })).toEqual({
      ok: false,
      reason: 'case-identifiers'
    })
  })
  it('case-identifiers: the skill description is checked too, not just the body', () => {
    // The description is the only thing a future agent matches on — a case slug or ticket key
    // leaking into it is exactly as bad there as in the body, and it lives OUTSIDE `fm.body`.
    expect(
      ok({ content: SKILL.replace('description: when Y', 'description: when AB-123 hangs') })
    ).toEqual({ ok: false, reason: 'case-identifiers' })
    expect(
      ok({ content: SKILL.replace('description: when Y', 'description: after nav-freeze-2026') })
    ).toEqual({ ok: false, reason: 'case-identifiers' })
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
  it('steps-in-reference only counts lines the edit ADDS — pre-existing numbered facts already in the reference do not block an unrelated edit', () => {
    const original = '# R\n1. a\n2. b\n3. c\n'
    expect(
      ok({
        type: 'reference-edit',
        target: 'r',
        original,
        content: original + '\nSome new prose fact, no numbers here.\n'
      })
    ).toEqual({ ok: true, flags: [] })
  })
  it('steps-in-reference still catches ≥3 NEW numbered lines added on top of an existing reference', () => {
    const original = '# R\nSome existing fact.\n'
    expect(
      ok({
        type: 'reference-edit',
        target: 'r',
        original,
        content: original + '\n1. x\n2. y\n3. z\n'
      })
    ).toEqual({ ok: false, reason: 'steps-in-reference' })
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
  it('broad-edit: a full rewrite of the substantive prose is not diluted by filler lines', () => {
    const fm = `---\nname: diagnose-y\ndescription: d\n---\n`
    const filler = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? '' : '---')).join('\n')
    const prose = ['one', 'two', 'three', 'four', 'five'].join('\n')
    const newProse = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n')
    const original = `${fm}${filler}\n${prose}\n`
    const edited = `${fm}${filler}\n${newProse}\n`
    expect(ok({ type: 'skill-edit', content: edited, original })).toEqual({
      ok: false,
      reason: 'broad-edit'
    })
  })
})
