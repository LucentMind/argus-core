import { describe, it, expect } from 'vitest'
import { reviewTag } from '../../../../shared/findingTag'
import { buildDossierPrompt } from '../v3/dossier'
import type { CaseDistillInput } from '../../../../shared/distill'

function input(findings: CaseDistillInput['findings']): CaseDistillInput {
  return {
    caseMeta: {
      slug: 'CASE-A',
      title: 'A',
      jiraKey: null,
      status: 'closed',
      resolution: 'solved',
      tags: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      closedAt: '2026-08-02T00:00:00.000Z'
    },
    findings,
    evidence: [],
    sessionTitles: [],
    skillsIndex: [],
    referencesIndex: [],
    rcaStructure: null,
    alreadyCaptured: { proposals: [] }
  } as unknown as CaseDistillInput
}

describe('reviewTag', () => {
  it('renders an agent retraction with its reason', () => {
    expect(
      reviewTag({ reviewState: 'rejected', reviewActor: 'agent', reviewReason: 'wrong call site' })
    ).toBe('rejected · retracted by agent: wrong call site')
  })

  it('leaves a human reject untouched', () => {
    expect(reviewTag({ reviewState: 'rejected', reviewActor: 'human', reviewReason: 'no' })).toBe(
      'rejected'
    )
  })

  it('treats a null actor as the human path', () => {
    expect(reviewTag({ reviewState: 'rejected', reviewActor: null, reviewReason: null })).toBe(
      'rejected'
    )
  })

  it('leaves pending and accepted untouched', () => {
    expect(reviewTag({ reviewState: 'pending' })).toBe('pending')
    expect(reviewTag({ reviewState: 'accepted', reviewActor: 'human' })).toBe('accepted')
  })
})

describe('dossier prompt', () => {
  it('shows the retraction and its reason in the findings section', () => {
    const q = buildDossierPrompt(
      input([
        {
          id: 7,
          summary: 'Race in parser',
          reviewState: 'rejected',
          reviewActor: 'agent',
          reviewReason: 'the guard is in the caller',
          role: null,
          body: 'b'
        }
      ])
    )
    expect(q).toContain('[#7 · rejected · retracted by agent: the guard is in the caller]')
  })

  it('renders a pre-change snapshot, which has neither field, exactly as before', () => {
    const q = buildDossierPrompt(
      input([{ id: 7, summary: 'Race', reviewState: 'rejected', role: null, body: 'b' }])
    )
    expect(q).toContain('[#7 · rejected] Race')
  })
})
