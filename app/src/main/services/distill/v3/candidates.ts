import type { CaseDistillInput } from '../../../../shared/distill'
import type { Dossier, KnowledgeCandidate } from '../../../../shared/distillV3'
import type { PromptTextSpecs } from '../../../../shared/promptSpec'
import { DistillParseError } from '../contract'

/** Stage 2b: which dossier items are durable knowledge, and where would each be found again?
 *  Decides WHAT and WHERE, never HOW it reads (that is stage 3). Sees index names only. */
export const CANDIDATES_CONTRACT = `You are selecting durable-knowledge candidates from an evidence dossier for a root-cause-analysis toolkit, and deciding where each would be found again. You produce candidates only — a later pass writes them, code checks them, and a human reviews every one. You do not write file contents here.

1. MISSION. High bar on TRUTH and GENERALITY; neutral on TYPE. Once an item passes the tests below, a procedure becomes a skill without apology — do not under-file procedures as references or squeeze them into an existing skill to seem conservative. Missing nothing durable and inventing nothing unestablished are equally the goal.
2. GENERALIZATION TEST. Strip the product name, ticket details, incidental version chronology and the exact incident timeline. If what remains is a useful instruction or fact for at least one future case, it is a candidate; state that residue in "generalization". If it only helps someone understand THIS incident, it is not a candidate.
3. SCOPE PRESERVATION. Keep version / deployment mode / feature flag / configuration / component scope whenever removing it could make a true statement false. Generalize the incident, not the fact.
4. NEVER CAPTURE: (a) negative claims about the AGENT'S OWN tools, backends or working environment ("X doesn't work") from this session — a scoped, evidenced limitation of the PRODUCT under investigation is a fact and belongs in a reference WITH its scope; (b) environment-dependent or transient failures; (c) one-off task narratives; (d) ruled-out hypotheses, except framed as "what it wasn't and how that was proven"; (e) anything from a session that ended without a working method, presented as validated.
5. DUPLICATES AND CONFLICTS. Never re-propose what "Knowledge already captured" lists. When a candidate may conflict with or supersede an existing skill/reference, name it in "related" and do not silently add a second truth: prefer an edit when the existing asset's scope includes the new fact; otherwise a new scoped asset. Never widen an asset merely to accommodate a conflict. Rejection notes on index entries and the reject digest are hard steers — do not propose in a direction named there.
6. PROCEDURE vs FACT. A "procedure" has an observable trigger, ordered investigation actions and a stop/confirmation condition. A list of facts, signatures, thresholds or explanations is a "fact" even when phrased imperatively.
7. TYPE PRECEDENCE:
   1. symptom-triggered procedure and NO installed skill's description claims that symptom → skill-new;
   2. procedure that falls INSIDE an installed skill's existing description → skill-edit;
   3. otherwise → reference-edit;
   4. never reference-edit because editing a skill would be inconvenient;
   5. never widen a skill's description to make skill-edit apply — that is a skill-new.
   A skill-new is CLASS-LEVEL; its name names the class of problem as a lowercase-hyphenated verb phrase (diagnose-…, analyze-…, check-…), never this case.
8. TARGETS. skill-edit target MUST be an installed skill name; skill-new target MUST NOT exist; reference-edit may name an existing team-knowledge reference or a new one (which creates it); NEVER a [tier: confluence] reference — put that knowledge in a new team-knowledge reference instead.
9. EVIDENCE. Every candidate's "evidence" lists ≥ 1 dossier path ("root_cause", "confirmed_fix", "diagnostic_path[2]", "durable_facts[0]", …) it rests on. A candidate with no dossier support is not a candidate.
10. OUTPUT. Order candidates by confidence, most confident first — a per-resolution cap is applied by CODE afterwards, so do NOT self-truncate to one item. Exactly one fenced \`\`\`json block: {"candidates": [{kind: procedure|fact, type: skill-new|skill-edit|reference-edit, target, title, outline, evidence[], related[], generalization, routing_rationale, confidence}]}. "outline" is always a plain string, never an object or array: for a procedure, write the trigger, ordered actions and stop condition as one prose string; for a fact, the scoped statement(s) as prose. {"candidates": []} is a valid answer.`

export const CANDIDATES_SECTIONS: PromptTextSpecs = {
  case: { title: 'Candidates section — case metadata', text: '# Case' },
  dossier: {
    title: 'Candidates section — dossier',
    text: '# Dossier (established evidence — the only source you may draw on)'
  },
  skills: {
    title: 'Candidates section — installed skills index',
    text: '# Installed skills (name — description; a skill-edit target must be one of these)'
  },
  references: {
    title: 'Candidates section — references index',
    text: '# References (name [tier] — summary; NEVER target a confluence tier)'
  },
  captured: {
    title: 'Candidates section — already captured',
    text: '# Knowledge already captured from this case (do NOT repeat)'
  },
  'reject-digest': {
    title: 'Candidates section — reject digest',
    text: '# Observed proposal failure patterns (do NOT propose in a direction named here)'
  },
  guidance: { title: 'Candidates section — operator guidance', text: '# Operator guidance' },
  'output-nudge': {
    title: 'Candidates — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function buildCandidatesPrompt(
  input: CaseDistillInput,
  dossier: Dossier,
  resolve?: (id: string) => string
): string {
  const m = input.caseMeta
  const sec = (key: string): string =>
    resolve
      ? resolve(`headless.case-distill.candidates.section.${key}`)
      : CANDIDATES_SECTIONS[key].text
  const captured =
    input.alreadyCaptured.proposals
      .map((p) => `- proposal [${p.state}] ${p.type} → ${p.target} — ${p.title}`)
      .join('\n') || '(none)'
  const parts = [
    resolve ? resolve('headless.case-distill.candidates.contract') : CANDIDATES_CONTRACT,
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\nstatus: ${m.status ?? 'closed'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}`,
    `${sec('dossier')}\n${JSON.stringify(dossier, null, 2)}`,
    `${sec('skills')}\n${input.skillsIndex.map((s) => `- ${s.name} — ${s.description}${s.note ? `\n  note: ${s.note}` : ''}`).join('\n') || '(none)'}`,
    `${sec('references')}\n${input.referencesIndex.map((r) => `- ${r.name} [tier: ${r.tier ?? 'team-knowledge'}] — ${r.summary}${r.note ? `\n  note: ${r.note}` : ''}`).join('\n') || '(none)'}`,
    `${sec('captured')}\n${captured}`
  ]
  if (input.rejectDigest) parts.push(`${sec('reject-digest')}\n${input.rejectDigest}`)
  if (input.operatorGuidance) parts.push(`${sec('guidance')}\n${input.operatorGuidance}`)
  parts.push(sec('output-nudge'))
  return parts.join('\n\n')
}

const KINDS = new Set(['procedure', 'fact'])
const TYPES = new Set(['skill-new', 'skill-edit', 'reference-edit'])
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** One candidate's own shape is bad (e.g. a structured `outline` instead of prose) — drop just
 *  that entry, not the batch: `null` here never becomes a thrown DistillParseError. */
function parseOneCandidate(c: unknown): KnowledgeCandidate | null {
  if (typeof c !== 'object' || c === null) return null
  const x = c as Record<string, unknown>
  if (!isStr(x.kind) || !KINDS.has(x.kind)) return null
  if (!isStr(x.type) || !TYPES.has(x.type)) return null
  if (!isStr(x.target) || !isStr(x.title) || !isStr(x.outline)) return null
  if (!Array.isArray(x.evidence)) return null
  const conf = typeof x.confidence === 'number' ? Math.min(1, Math.max(0, x.confidence)) : 0.5
  return {
    kind: x.kind as KnowledgeCandidate['kind'],
    type: x.type as KnowledgeCandidate['type'],
    target: x.target.trim(),
    title: x.title.trim(),
    outline: x.outline,
    evidence: strArr(x.evidence),
    related: strArr(x.related),
    generalization: typeof x.generalization === 'string' ? x.generalization : '',
    routing_rationale: typeof x.routing_rationale === 'string' ? x.routing_rationale : '',
    confidence: conf
  }
}

export function parseCandidates(text: string): {
  candidates: KnowledgeCandidate[]
  malformedDropped: number
} {
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
  for (const k of Object.keys(o))
    if (k !== 'candidates') throw new DistillParseError(`unknown key "${k}"`, text)
  if (!Array.isArray(o.candidates)) throw new DistillParseError('candidates must be an array', text)
  const candidates: KnowledgeCandidate[] = []
  let malformedDropped = 0
  for (const c of o.candidates) {
    const parsed = parseOneCandidate(c)
    if (parsed) candidates.push(parsed)
    else malformedDropped++
  }
  return { candidates, malformedDropped }
}
