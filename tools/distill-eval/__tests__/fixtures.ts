import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'

export function line(over: Partial<DistillEvalBundleLine['job']> = {}): DistillEvalBundleLine {
  return {
    job: {
      id: 1,
      caseSlug: 'nav-1',
      promptHash: 'ffffffffffff',
      createdAt: 'x',
      state: 'done',
      inputSnapshot: {
        caseMeta: {
          slug: 'nav-1', title: 't', jiraKey: null, status: 'closed', resolution: null,
          tags: [], createdAt: 'x', closedAt: 'x'
        },
        findings: [], evidence: [], sessionTitles: [],
        skillsIndex: [], referencesIndex: [],
        alreadyCaptured: { proposals: [] },
        rcaStructure: null
      },
      rawOutput: '```json\n{"summary": {"signature": "s", "symptoms": "s", "rootCause": "r", "fix": "f", "keywords": ["k"]}}\n```',
      error: null,
      ...over
    },
    items: [],
    exportedAt: 'x',
    argusVersion: '1.0.0'
  }
}
