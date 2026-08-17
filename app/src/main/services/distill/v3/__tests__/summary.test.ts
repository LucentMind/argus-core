import { describe, it, expect } from 'vitest'
import { buildSummaryPrompt, parseSummary } from '../summary'
import { DistillParseError } from '../../contract'
import type { Dossier } from '../../../../../shared/distillV3'
import type { CaseDistillInput } from '../../../../../shared/distill'

const META: CaseDistillInput['caseMeta'] = {
  slug: 'c1',
  title: 'Freeze',
  jiraKey: 'AB-1',
  status: 'closed',
  resolution: 'solved',
  tags: [],
  createdAt: 'a',
  closedAt: 'b'
}
const INPUT = { caseMeta: META } as CaseDistillInput
const D: Dossier = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'stranded flag', cites: [{ finding: 7 }] },
  confirmed_fix: { text: 'reset flag', applied: true, cites: [{ finding: 7 }] },
  rejected_hypotheses: [],
  diagnostic_path: [],
  durable_facts: [],
  user_corrections: []
}

describe('buildSummaryPrompt', () => {
  it('carries case meta and the dossier JSON, nothing else', () => {
    const p = buildSummaryPrompt(INPUT, D)
    expect(p).toContain('jira: AB-1')
    expect(p).toContain('"stranded flag"')
    expect(p).toContain('# Dossier')
  })
  it('honours the resolver', () => {
    expect(
      buildSummaryPrompt(INPUT, D, (id) => `<<${id}>>`).startsWith(
        '<<headless.case-distill.summary.contract>>'
      )
    ).toBe(true)
  })
})

describe('parseSummary', () => {
  it('returns null for {"summary":null} and for {}', () => {
    expect(parseSummary('```json\n{"summary":null}\n```')).toBeNull()
    expect(parseSummary('```json\n{}\n```')).toBeNull()
  })
  it('returns the summary when valid', () => {
    const s = parseSummary(
      '```json\n{"summary":{"signature":"s","symptoms":"y","rootCause":"r","fix":"f","keywords":["k"]}}\n```'
    )
    expect(s?.signature).toBe('s')
  })
  it('throws on missing fields or unknown keys', () => {
    expect(() => parseSummary('```json\n{"summary":{"signature":"s"}}\n```')).toThrow(
      DistillParseError
    )
    expect(() => parseSummary('```json\n{"proposals":[]}\n```')).toThrow(DistillParseError)
  })
})
