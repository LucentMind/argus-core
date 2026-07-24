import type {
  CaseDistillInput,
  CaseDistillOutput,
  CaseDistillSummary
} from '../../../shared/distill'

export { CASE_DISTILL_CONTRACT } from './caseDistillContract'
import { CASE_DISTILL_CONTRACT } from './caseDistillContract'

export function buildCaseDistillPrompt(input: CaseDistillInput): string {
  const m = input.caseMeta
  const findings = input.findings
    .map((f) => `### [${f.reviewState}] ${f.summary}\n${f.body}`)
    .join('\n\n')
  const captured =
    [
      ...input.alreadyCaptured.proposals.map(
        (p) => `- proposal [${p.state}] ${p.type} → ${p.target} — ${p.title}`
      ),
      ...input.alreadyCaptured.memoryWrites.map(
        (w) => `- memory write → ${w.topic}${w.indexEntry ? ` — ${w.indexEntry}` : ''}`
      )
    ].join('\n') || '(none)'
  return [
    CASE_DISTILL_CONTRACT,
    `# Case\nslug: ${m.slug}\ntitle: ${m.title}\njira: ${m.jiraKey ?? '—'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}\nopened: ${m.createdAt}\nclosed: ${m.closedAt}`,
    `# Findings (with review states)\n\n${findings || '(none)'}`,
    `# Evidence inventory\n${input.evidence.map((e) => `- ${e.relPath} (${e.artifactType}, ${e.size} bytes)`).join('\n') || '(none)'}`,
    `# Chat sessions\n${input.sessionTitles.map((t) => `- ${t}`).join('\n') || '(none)'}`,
    `# Memory index (topics that already exist)\n${input.memoryIndex || '(empty)'}`,
    `# Installed skills (full current content — a skill-edit must return the whole file with its change merged in)\n${
      input.skillsIndex
        .map((s) => `## ${s.name} — ${s.description}\n\n${s.content}`)
        .join('\n\n---\n\n') || '(none)'
    }`,
    `# References (full current content — a reference-edit must return the whole file with its change merged in; NEVER edit a [tier: confluence] reference — see rule 7)\n${
      input.referencesIndex
        .map(
          (r) => `## ${r.name} [tier: ${r.tier ?? 'team-knowledge'}] — ${r.summary}\n\n${r.content}`
        )
        .join('\n\n---\n\n') || '(none)'
    }`,
    `# Knowledge already captured from this case (do NOT repeat)\n${captured}`,
    `Return exactly one fenced \`\`\`json block now.`
  ].join('\n\n')
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
    if (!['summary', 'memoryAppends', 'proposals'].includes(k))
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
  if (o.memoryAppends !== undefined) {
    if (!Array.isArray(o.memoryAppends))
      throw new DistillParseError('memoryAppends must be an array', text)
    for (const m of o.memoryAppends as Record<string, unknown>[]) {
      if (typeof m !== 'object' || m === null)
        throw new DistillParseError('memoryAppends entry must be an object', text)
      if (!isStr(m.topic) || !isStr(m.content))
        throw new DistillParseError('memoryAppends entry invalid', text)
      if (m.indexEntry !== undefined && !isStr(m.indexEntry))
        throw new DistillParseError('indexEntry invalid', text)
    }
    out.memoryAppends = o.memoryAppends as CaseDistillOutput['memoryAppends']
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
