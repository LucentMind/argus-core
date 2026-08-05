import type {
  CaseDistillInput,
  CaseDistillOutput,
  CaseDistillSummary
} from '../../../shared/distill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

export { CASE_DISTILL_CONTRACT } from './caseDistillContract'
import { CASE_DISTILL_CONTRACT } from './caseDistillContract'

/** Section headers of the case-close distillation prompt. The payload under each header is
 *  assembled from the case and stays in code — only the header text is registered. */
export const CASE_DISTILL_SECTIONS: PromptTextSpecs = {
  case: { title: 'Case-distill section — case metadata', text: '# Case' },
  findings: {
    title: 'Case-distill section — findings',
    text: '# Findings (with review states)'
  },
  evidence: { title: 'Case-distill section — evidence', text: '# Evidence inventory' },
  sessions: { title: 'Case-distill section — chat sessions', text: '# Chat sessions' },
  skills: {
    title: 'Case-distill section — installed skills',
    text: '# Installed skills (full current content — a skill-edit must return the whole file with its change merged in)'
  },
  references: {
    title: 'Case-distill section — references',
    text: '# References (full current content — a reference-edit must return the whole file with its change merged in; NEVER edit a [tier: confluence] reference — see rule 7)'
  },
  rca: {
    title: 'Case-distill section — confirmed RCA structure',
    text: '# Confirmed RCA structure (human-reviewed)'
  },
  captured: {
    title: 'Case-distill section — already captured',
    text: '# Knowledge already captured from this case (do NOT repeat)'
  },
  'output-nudge': {
    title: 'Case-distill — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function buildCaseDistillPrompt(
  input: CaseDistillInput,
  resolve?: (id: string) => string
): string {
  const m = input.caseMeta
  const findings = input.findings
    .map((f) => `### [${f.reviewState}${f.role ? ` · ${f.role}` : ''}] ${f.summary}\n${f.body}`)
    .join('\n\n')
  const captured =
    input.alreadyCaptured.proposals
      .map((p) => `- proposal [${p.state}] ${p.type} → ${p.target} — ${p.title}`)
      .join('\n') || '(none)'
  const sec = (key: string): string =>
    resolve ? resolve(`headless.case-distill.section.${key}`) : CASE_DISTILL_SECTIONS[key].text
  const parts = [
    resolve ? resolve('headless.case-distill.contract') : CASE_DISTILL_CONTRACT,
    // `m.status` is absent on a pre-upgrade `input_snapshot` (retry replays the original
    // snapshot verbatim, and a failed job's retry button persists for the life of the case) —
    // every such snapshot predates the open-case distill path, so it was always a closed case.
    // Falling back to 'closed' (and gating on `!== 'open'` rather than `=== 'closed'`) keeps a
    // legacy snapshot rendering exactly as it did pre-branch instead of the literal string
    // "status: undefined" with the `closed:` timestamp silently dropped.
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\njira: ${m.jiraKey ?? '—'}\nstatus: ${m.status ?? 'closed'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}\nopened: ${m.createdAt}${m.status !== 'open' ? `\nclosed: ${m.closedAt}` : ''}`,
    `${sec('findings')}\n\n${findings || '(none)'}`,
    `${sec('evidence')}\n${input.evidence.map((e) => `- ${e.relPath} (${e.artifactType}, ${e.size} bytes)`).join('\n') || '(none)'}`,
    `${sec('sessions')}\n${input.sessionTitles.map((t) => `- ${t}`).join('\n') || '(none)'}`,
    `${sec('skills')}\n${
      input.skillsIndex
        .map((s) => `## ${s.name} — ${s.description}\n\n${s.content}`)
        .join('\n\n---\n\n') || '(none)'
    }`,
    `${sec('references')}\n${
      input.referencesIndex
        .map(
          (r) => `## ${r.name} [tier: ${r.tier ?? 'team-knowledge'}] — ${r.summary}\n\n${r.content}`
        )
        .join('\n\n---\n\n') || '(none)'
    }`
  ]
  // Only when a report was confirmed for this case — omitting the section entirely (rather than
  // rendering "(none)") keeps the prompt byte-identical to before this field existed for the
  // common case of a case with no confirmed RCA.
  if (input.rcaStructure) {
    parts.push(`${sec('rca')}\n${JSON.stringify(input.rcaStructure, null, 2)}`)
  }
  parts.push(`${sec('captured')}\n${captured}`)
  parts.push(sec('output-nudge'))
  return parts.join('\n\n')
}

export class DistillParseError extends Error {
  constructor(
    message: string,
    public raw: string
  ) {
    super(message)
  }
}

const PROPOSAL_OUT_TYPES = new Set(['skill-new', 'skill-edit', 'reference-edit', 'recipe'])
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function parseCaseDistillOutput(text: string): CaseDistillOutput {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1)
    throw new DistillParseError(`expected exactly 1 json fence, got ${fences.length}`, text)
  let obj: unknown
  try {
    obj = JSON.parse(fences[0][1])
  } catch (e) {
    throw new DistillParseError(`invalid JSON: ${(e as Error).message}`, text)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new DistillParseError('output is not an object', text)
  const o = obj as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!['summary', 'proposals'].includes(k))
      throw new DistillParseError(`unknown key "${k}"`, text)
  }
  const out: CaseDistillOutput = {}
  if (o.summary !== undefined) {
    const s = o.summary as Record<string, unknown>
    if (typeof s !== 'object' || s === null)
      throw new DistillParseError('summary must be an object', text)
    if (
      !isStr(s.signature) ||
      !isStr(s.symptoms) ||
      !isStr(s.rootCause) ||
      !isStr(s.fix) ||
      !Array.isArray(s.keywords) ||
      !s.keywords.every((k) => isStr(k))
    ) {
      throw new DistillParseError('summary fields invalid', text)
    }
    out.summary = s as unknown as CaseDistillSummary
  }
  if (o.proposals !== undefined) {
    if (!Array.isArray(o.proposals)) throw new DistillParseError('proposals must be an array', text)
    for (const p of o.proposals as Record<string, unknown>[]) {
      if (typeof p !== 'object' || p === null)
        throw new DistillParseError('proposal must be an object', text)
      if (!isStr(p.type) || !PROPOSAL_OUT_TYPES.has(p.type))
        throw new DistillParseError(`bad proposal type "${String(p.type)}"`, text)
      if (!isStr(p.target) || !isStr(p.title) || !isStr(p.content))
        throw new DistillParseError('proposal fields invalid', text)
    }
    out.proposals = o.proposals as CaseDistillOutput['proposals']
  }
  return out
}
