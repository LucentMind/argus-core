import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'
import type { DistillWorld } from '../../../app/src/shared/distill'

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

// ── v3 pipeline fixtures ────────────────────────────────────────────────────────────────────
// Stage outputs mirroring `app/.../v3/__tests__/pipeline.test.ts`: real shapes the real stage
// parsers accept, so a drift in a stage contract breaks the harness tests too.

export const V3_SKILL = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Steps\n1. a\n`
export const V3_WORLD: DistillWorld = {
  sessions: [{ id: 1, title: 'only session', messages: [{ role: 'user', content: 'NEEDLE' }] }]
}
export const V3_DOSSIER =
  '```json\n{"scope":{"status":"closed","resolution":"solved","settled":true,"note":""},"root_cause":{"text":"rc for diagnose-x","cites":[{"finding":7}]},"confirmed_fix":null,"rejected_hypotheses":[],"diagnostic_path":[],"durable_facts":[],"user_corrections":[]}\n```'
export const V3_SUMMARY =
  '```json\n{"summary":{"signature":"s","symptoms":"y","rootCause":"r","fix":"f","keywords":["k"]}}\n```'
export const V3_CANDS =
  '```json\n{"candidates":[{"kind":"procedure","type":"skill-edit","target":"diagnose-x","title":"t","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.9},{"kind":"procedure","type":"skill-new","target":"diagnose-x","title":"dup","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.5}]}\n```'
export const V3_MAT =
  '```json\n{"ops":[{"op":"append-section","heading":"## Steps","content":"2. b"}],"basis":"a real basis of twenty+ chars"}\n```'

/** Which tool-less stage a prompt belongs to (same routing the app-side pipeline test uses). */
export const v3Route = (p: string): string =>
  p.includes('# Dossier (established') ? V3_CANDS : p.includes('# Candidate') ? V3_MAT : V3_SUMMARY

/** A corpus line whose snapshot the v3 pipeline can actually run end to end. */
export function v3Line(
  over: Partial<DistillEvalBundleLine['job']> = {},
  world: DistillWorld | null = V3_WORLD
): DistillEvalBundleLine {
  const l = line(over)
  l.job.inputSnapshot = {
    ...l.job.inputSnapshot,
    findings: [{ id: 7, summary: 'f', reviewState: 'accepted', role: 'root-cause', body: '' }],
    skillsIndex: [{ name: 'diagnose-x', description: 'when X', content: V3_SKILL }],
    ...(world ? { world } : {})
  }
  return l
}
