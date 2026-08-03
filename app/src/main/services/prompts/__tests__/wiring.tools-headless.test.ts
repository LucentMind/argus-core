import { describe, it, expect } from 'vitest'
import { resolveToolSpecs, NATIVE_TOOL_SPECS } from '../../agent/nativeTools'
import { buildCaseDistillPrompt, CASE_DISTILL_SECTIONS } from '../../distill/contract'
import { CASE_DISTILL_CONTRACT } from '../../distill/caseDistillContract'
import { buildDistillPrompt, DISTILL_CONTRACT, REF_DISTILL_SECTIONS } from '../../refSync/distill'
import { AUTHORING_SECTIONS } from '../../authoring/prompts'
import { RCA_SECTIONS } from '../../rca/contract'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { RcaDraft } from '../../../../shared/rca'
import { PROMPT_ENTRIES } from '../registry'

const stub = (id: string): string => `<<${id}>>`

/** `rcaStructure` defaults to null (no confirmed report) — the common case, and the one the
 *  byte-identical-without-a-report tests below rely on. Pass a draft explicitly for tests that
 *  need the conditional `rca` section to render. */
function distillInput(rcaStructure: RcaDraft | null = null): CaseDistillInput {
  return {
    caseMeta: {
      slug: 'c-1',
      title: 'T',
      jiraKey: null,
      status: 'closed',
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
    rcaStructure,
    alreadyCaptured: { proposals: [], memoryWrites: [] }
  }
}

const SAMPLE_DRAFT: RcaDraft = {
  rootCause: { findingId: null, statement: 's', evidence: [] },
  contributing: [],
  symptoms: [],
  ruledOut: [],
  duplicates: [],
  impact: '',
  timeline: [],
  remediation: { immediate: '', followUps: [] },
  execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
  techNarrative: []
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
    // Scaffolding is registered too as of Plan 3 — resolved just like the contract.
    expect(out).toContain('<<headless.case-distill.section.evidence>>')
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
    // Scaffolding is registered too as of Plan 3 — resolved just like the contract.
    expect(out).toContain('<<headless.ref-distill.section.target>>')
  })

  it('reference-distill prompt with no resolver leads with the constant', () => {
    const out = buildDistillPrompt({ target: 'references/x.md', currentBody: null, pages: [] })
    expect(out.startsWith(DISTILL_CONTRACT)).toBe(true)
  })
})

describe('distill scaffolding honours an injected resolver', () => {
  it('registers one entry per section key', () => {
    const ids = PROMPT_ENTRIES.filter((e) => e.id.includes('.section.')).map((e) => e.id)
    expect(ids.sort()).toEqual(
      [
        ...Object.keys(CASE_DISTILL_SECTIONS).map((k) => `headless.case-distill.section.${k}`),
        ...Object.keys(REF_DISTILL_SECTIONS).map((k) => `headless.ref-distill.section.${k}`),
        ...Object.keys(AUTHORING_SECTIONS).map((k) => `headless.authoring.section.${k}`),
        ...Object.keys(RCA_SECTIONS).map((k) => `headless.case-rca.section.${k}`)
      ].sort()
    )
  })

  it('every case-distill section header is resolved, not just the contract', () => {
    // rcaStructure is populated so the conditional `rca` section renders too — otherwise this
    // exhaustive loop over CASE_DISTILL_SECTIONS would fail on a section that never appears.
    const out = buildCaseDistillPrompt(distillInput(SAMPLE_DRAFT), stub)
    for (const key of Object.keys(CASE_DISTILL_SECTIONS)) {
      expect(out, key).toContain(`<<headless.case-distill.section.${key}>>`)
    }
  })

  it('case-distill payloads survive the rewiring', () => {
    const out = buildCaseDistillPrompt(distillInput(), stub)
    expect(out).toContain('slug: c-1')
    expect(out).toContain('(none)')
  })

  it('with no resolver the case-distill prompt is byte-identical to the defaults', () => {
    const out = buildCaseDistillPrompt(distillInput())
    expect(out).toContain('# Evidence inventory')
    expect(out).toContain(
      '# Installed skills (full current content — a skill-edit must return the whole file with its change merged in)'
    )
    expect(out.endsWith('Return exactly one fenced ```json block now.')).toBe(true)
  })

  it('no-resolver case-distill prompt keeps its section structure and separator count intact', () => {
    // startsWith/endsWith and toContain above only anchor the first/last element and spot-check
    // substrings — a regression that dropped or duplicated a '\n\n' between two *middle*
    // sections would slip past both. This test asserts the structure instead: every section
    // header from CASE_DISTILL_SECTIONS appears, in order, at the start of some '\n\n'-delimited
    // chunk, and the total chunk count for this fixed input is pinned so a missing or doubled
    // separator fails the test even though the prose payload is never asserted.
    const out = buildCaseDistillPrompt(distillInput())
    const parts = out.split('\n\n')

    // Pins the separator count for this deterministic input: the contract text plus one
    // hardcoded extra break in the (empty) findings section split it into 12 chunks. Any
    // dropped or added '\n\n' anywhere in the assembly changes this number.
    expect(parts.length).toBe(12)
    expect(out.startsWith(CASE_DISTILL_CONTRACT)).toBe(true)

    let cursor = 0
    // 'rca' is excluded: this fixed input has no confirmed RCA structure (rcaStructure: null),
    // so the whole section — header included — is deliberately omitted, not rendered as "(none)".
    // Covered separately by the RCA-present assertion above and the byte-identical test below.
    for (const key of Object.keys(CASE_DISTILL_SECTIONS).filter((k) => k !== 'rca')) {
      const header = CASE_DISTILL_SECTIONS[key].text
      const idx = parts.findIndex((p, i) => i >= cursor && p.startsWith(header))
      expect(
        idx,
        `section "${key}" header not found in order at/after chunk ${cursor}`
      ).toBeGreaterThanOrEqual(cursor)
      cursor = idx + 1
    }
  })

  it('with no confirmed RCA structure, no resolver, the case-distill prompt has no rca section', () => {
    const out = buildCaseDistillPrompt(distillInput())
    expect(out).not.toContain('Confirmed RCA structure')
  })

  it('refSync section headers resolve and keep the target filled in', () => {
    const out = buildDistillPrompt(
      { target: 'references/x.md', currentBody: null, pages: [] },
      stub
    )
    for (const key of Object.keys(REF_DISTILL_SECTIONS)) {
      expect(out, key).toContain(`<<headless.ref-distill.section.${key}>>`)
    }
  })

  it('with no resolver the refSync prompt still names the target file', () => {
    const out = buildDistillPrompt({ target: 'references/x.md', currentBody: null, pages: [] })
    expect(out).toContain('# Target file: references/x.md')
    expect(out).toContain('Return ONLY the complete updated body of references/x.md as markdown.')
  })
})
