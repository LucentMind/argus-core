import { describe, it, expect } from 'vitest'
import { resolveToolSpecs, NATIVE_TOOL_SPECS } from '../../agent/nativeTools'
import { buildCaseDistillPrompt } from '../../distill/contract'
import { CASE_DISTILL_CONTRACT } from '../../distill/caseDistillContract'
import { buildDistillPrompt, DISTILL_CONTRACT } from '../../refSync/distill'
import type { CaseDistillInput } from '../../../../shared/distill'

const stub = (id: string): string => `<<${id}>>`

function distillInput(): CaseDistillInput {
  return {
    caseMeta: {
      slug: 'c-1',
      title: 'T',
      jiraKey: null,
      resolution: 'solved',
      tags: [],
      createdAt: '2026-01-01T00:00:00Z',
      closedAt: '2026-01-02T00:00:00Z'
    },
    findings: [],
    evidence: [],
    sessionTitles: [],
    memoryIndex: '',
    skillsIndex: [],
    referencesIndex: [],
    alreadyCaptured: { proposals: [], memoryWrites: [] }
  }
}

describe('tool descriptions honour an injected resolver', () => {
  it('resolveToolSpecs swaps every description by id and keeps name and schema', () => {
    const specs = resolveToolSpecs(stub)
    expect(specs.length).toBe(NATIVE_TOOL_SPECS.length)
    for (const [i, s] of specs.entries()) {
      expect(s.name).toBe(NATIVE_TOOL_SPECS[i].name)
      expect(s.schema).toBe(NATIVE_TOOL_SPECS[i].schema)
      expect(s.description).toBe(`<<tool.${s.name}.description>>`)
    }
  })

  it('resolveToolSpecs with no resolver returns the table unchanged', () => {
    const specs = resolveToolSpecs()
    expect(specs.map((s) => s.description)).toEqual(NATIVE_TOOL_SPECS.map((s) => s.description))
  })

  it('resolveToolSpecs does not mutate the source table', () => {
    const before = NATIVE_TOOL_SPECS[0].description
    resolveToolSpecs(stub)
    expect(NATIVE_TOOL_SPECS[0].description).toBe(before)
  })
})

describe('headless contracts honour an injected resolver', () => {
  it('case-distill prompt leads with the resolved contract', () => {
    const out = buildCaseDistillPrompt(distillInput(), stub)
    expect(out.startsWith('<<headless.case-distill.contract>>')).toBe(true)
    // Scaffolding stays hardcoded in Plan 1 — Plan 3 registers it.
    expect(out).toContain('# Evidence inventory')
  })

  it('case-distill prompt with no resolver leads with the constant', () => {
    expect(buildCaseDistillPrompt(distillInput()).startsWith(CASE_DISTILL_CONTRACT)).toBe(true)
  })

  it('reference-distill prompt leads with the resolved contract', () => {
    const out = buildDistillPrompt(
      { target: 'references/x.md', currentBody: null, pages: [] },
      stub
    )
    expect(out.startsWith('<<headless.ref-distill.contract>>')).toBe(true)
    expect(out).toContain('# Target file: references/x.md')
  })

  it('reference-distill prompt with no resolver leads with the constant', () => {
    const out = buildDistillPrompt({ target: 'references/x.md', currentBody: null, pages: [] })
    expect(out.startsWith(DISTILL_CONTRACT)).toBe(true)
  })
})
