import { describe, it, expect } from 'vitest'
import { validateSkill, validateReference, hasErrors } from '../assetValidation'

const good = [
  '---',
  'name: rca',
  'description: Use when a finding needs a root cause.',
  '---',
  '',
  '# rca',
  'Body.'
].join('\n')

describe('validateSkill', () => {
  it('accepts a well-formed skill', () => {
    expect(validateSkill({ name: 'rca', content: good })).toEqual([])
  })

  it('rejects a missing frontmatter fence', () => {
    const issues = validateSkill({ name: 'rca', content: '# rca\nBody.' })
    expect(hasErrors(issues)).toBe(true)
    expect(issues[0].message).toMatch(/frontmatter/i)
  })

  it('rejects an empty description', () => {
    const content = good.replace(
      'description: Use when a finding needs a root cause.',
      'description:'
    )
    const issues = validateSkill({ name: 'rca', content })
    expect(hasErrors(issues)).toBe(true)
    expect(issues.some((i) => /description/i.test(i.message))).toBe(true)
  })

  it('rejects a name that does not match the directory', () => {
    const issues = validateSkill({ name: 'rca', content: good.replace('name: rca', 'name: other') })
    expect(issues.some((i) => i.severity === 'error' && /name/i.test(i.message))).toBe(true)
  })

  it('rejects a name that is not a legal directory name', () => {
    const issues = validateSkill({
      name: '../evil',
      content: good.replace('name: rca', 'name: ../evil')
    })
    expect(hasErrors(issues)).toBe(true)
  })

  it('rejects an empty body', () => {
    const content = ['---', 'name: rca', 'description: Something useful.', '---', '', ''].join('\n')
    expect(hasErrors(validateSkill({ name: 'rca', content }))).toBe(true)
  })

  it('accepts CRLF files', () => {
    const crlf = good.split('\n').join('\r\n')
    expect(validateSkill({ name: 'rca', content: crlf })).toEqual([])
  })

  it('accepts a known role', () => {
    const content = good.replace('---\n\n# rca', 'roles: [review, triage]\n---\n\n# rca')
    expect(validateSkill({ name: 'rca', content })).toEqual([])
  })

  it('warns, but does not error, on an unknown role', () => {
    const content = good.replace('---\n\n# rca', 'roles: [nonsense]\n---\n\n# rca')
    const issues = validateSkill({ name: 'rca', content })
    expect(hasErrors(issues)).toBe(false)
    expect(issues.map((i) => i.severity)).toEqual(['warning'])
  })

  it('errors when a roles key is present but yields nothing', () => {
    const content = good.replace('---\n\n# rca', 'roles:\n---\n\n# rca')
    expect(hasErrors(validateSkill({ name: 'rca', content }))).toBe(true)
  })
})

describe('validateReference', () => {
  it('accepts a plain markdown reference with no frontmatter', () => {
    expect(validateReference({ file: 'jira-fields.md', content: '# Jira fields\nBody.' })).toEqual(
      []
    )
  })

  it('rejects a name that fails REF_TARGET_RE', () => {
    expect(hasErrors(validateReference({ file: '../evil.md', content: 'Body.' }))).toBe(true)
  })

  it('rejects a name without the .md suffix', () => {
    expect(hasErrors(validateReference({ file: 'notes', content: 'Body.' }))).toBe(true)
  })

  it('rejects the generated index file', () => {
    expect(hasErrors(validateReference({ file: 'INDEX.md', content: 'Body.' }))).toBe(true)
  })

  // Finding 5: must agree with `isGeneratedAsset` (assetEditable.ts), which is case-insensitive
  // because the filesystem is. Disagreeing would let a differently-cased index open as an
  // editable buffer that this function still refuses to save.
  it('rejects the generated index file under any casing', () => {
    expect(hasErrors(validateReference({ file: 'index.md', content: 'Body.' }))).toBe(true)
    expect(hasErrors(validateReference({ file: 'Index.Md', content: 'Body.' }))).toBe(true)
  })

  it('rejects empty content', () => {
    expect(hasErrors(validateReference({ file: 'notes.md', content: '   ' }))).toBe(true)
  })
})
