import type {
  CaseDistillInput,
  CaseDistillOutput,
  CaseDistillSummary
} from '../../../shared/distill'

export const CASE_DISTILL_CONTRACT = `You are distilling a CLOSED root-cause-analysis case into durable knowledge for an RCA toolkit. You produce candidates only — a human reviews every item before anything is applied.

Rules — follow every one:
1. SUMMARY ONLY IF RECURRENCE-RELEVANT: emit "summary" only when this case could recur or attract near-duplicate defects in the future. Otherwise omit the key entirely.
2. WEIGHT BY REVIEW STATE: findings marked [accepted] are confirmed; [rejected] means ruled out — usable only as "what turned out to be wrong"; [pending] is unreviewed.
3. GENERALIZE memory and proposal content: no ticket numbers, customer names, secrets, or case paths. The summary is case-scoped and MAY keep identifiers.
4. MEMORY = durable cross-case FACTS ("what is true"). PROPOSALS = reusable PROCEDURES ("what to do"). Do not mix them.
5. TARGET REAL NAMES: skill-edit / reference-edit targets and memory topics must come from the provided indexes; invent names only for skill-new / recipe.
6. AN EMPTY RESULT IS A VALID RESULT: for duplicate / rejected / not-reproducible closes with nothing generalizable, return {}.
7. NO DUPLICATE LEARNINGS: the "Knowledge already captured from this case" section lists what was already proposed or recorded during the case. Never re-propose or re-record anything listed there. If everything was already captured, return {}.
8. PROPOSAL CONTENT IS A COMPLETE FILE: every proposal's "content" is the entire file to save, ready as-is, frontmatter included — never a diff and never a fragment. For skill-edit / reference-edit, take the current file (shown verbatim under "Installed skills" / "References" below), merge your change into it, and return the WHOLE resulting file with every unchanged line preserved exactly. For skill-new / recipe, write the complete new file from scratch.
9. OUTPUT: exactly one fenced \`\`\`json block containing one JSON object with optional keys "summary" ({signature, symptoms, rootCause, fix, keywords[]}, all required inside), "memoryAppends" ([{"topic" (lowercase letters, digits, hyphens), content, indexEntry? — the description ONLY, never restating the topic name}]), "proposals" ([{type: skill-new|skill-edit|reference-edit|recipe, target, title, content}]). No other keys. "signature" is ONE line. No commentary inside the block.`

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
    `# References (full current content — a reference-edit must return the whole file with its change merged in)\n${
      input.referencesIndex
        .map((r) => `## ${r.name} — ${r.summary}\n\n${r.content}`)
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
