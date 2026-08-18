import type { CaseDistillInput, CaseDistillOutput } from '../../../../shared/distill'
import type {
  Dossier,
  DossierCite,
  KnowledgeCandidate,
  MaterializeOutput,
  PatchOp
} from '../../../../shared/distillV3'
import type { PromptTextSpecs } from '../../../../shared/promptSpec'
import { DistillParseError } from '../contract'
import { resolveDossierPath } from './dossier'
import { applyPatch } from './patch'

/** Stage 3: write ONE candidate as a file a reviewer can accept. Tool-less; sees the candidate,
 *  its resolved evidence, its ONE target file (edits), and any `related` files by name. */
export const MATERIALIZE_CONTRACT = `You are writing one knowledge asset for a root-cause-analysis toolkit from a candidate a previous pass selected. A human reviews the result. Write only what the candidate and its evidence establish.

Rules:
1. CONTENT IS COMPLETE AND READY: for skill-new return the entire SKILL.md (frontmatter with "name:" equal to the target and a "description:" that names the SYMPTOM in the words someone would report it — that description is all a future agent matches on; then the body). For skill-edit / reference-edit return PATCH OPS against the target file shown below — never a rewritten copy. Each op is {op, heading: "<exact heading line>", content}: append-section adds content at the END of the named section; replace-section replaces that section's body and keeps its heading; insert-after inserts a NEW block (normally with its own heading) immediately after that section. {op: "append-file", content} adds at the end of the file and takes no heading. Optionally {"frontmatter": {"description": "..."}} when the description must change — a description-only change may send frontmatter alone with no ops. Only when the change cannot be expressed as ops (a structural rewrite) return "whole_file" with the complete file — this is flagged for the reviewer.
2. A reference-edit whose target does not exist yet CREATES it: use append-file ops with a "# Title" line first; references have no frontmatter and NO numbered steps. A skill's body has ordered steps; a reference has facts.
3. GENERALIZE THE INCIDENT, KEEP THE SCOPE: no ticket numbers, customer names, secrets, case slugs or paths; keep every version / mode / flag / component qualifier the candidate carries — dropping one may make a true statement false.
4. RELATED ASSETS: when a related file shown below conflicts with the candidate, express the change as an edit or as a scoped statement that names the condition under which each holds; never leave two contradicting facts. List anything this candidate supersedes in "supersedes" [{asset, note}].
5. PRESERVE: an edit changes only what the candidate needs; every unchanged line of the target stays exactly as it is (ops guarantee this — that is why they are required).
6. BASIS: "basis" is 1–2 lines for the reviewer citing the concrete finding or transcript moment behind this asset — human-readable, not JSON.
7. OUTPUT: exactly one fenced \`\`\`json block: skill-new → {"file", "basis"}; edits → {"ops"[], "frontmatter"?, "supersedes"?, "whole_file"?, "basis"}. No other keys, no commentary inside the block.`

export const MATERIALIZE_SECTIONS: PromptTextSpecs = {
  candidate: { title: 'Materialize section — candidate', text: '# Candidate' },
  evidence: {
    title: 'Materialize section — evidence',
    text: '# Evidence (resolved dossier items — the only source you may draw on)'
  },
  target: {
    title: 'Materialize section — target file',
    text: '# Target file (current content — your ops apply to exactly this)'
  },
  related: {
    title: 'Materialize section — related assets',
    text: '# Related assets (full content — check for conflicts, do not edit these)'
  },
  'output-nudge': {
    title: 'Materialize — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function findTargetContent(
  input: CaseDistillInput,
  type: KnowledgeCandidate['type'],
  name: string
): string | undefined {
  if (type === 'reference-edit') return input.referencesIndex.find((r) => r.name === name)?.content
  return input.skillsIndex.find((s) => s.name === name)?.content
}

/** A skill and a reference may share a name — return every match with its kind so callers can
 *  render each distinctly instead of one silently shadowing the other. */
function findAllContent(
  input: CaseDistillInput,
  name: string
): { kind: 'skill' | 'reference'; body: string }[] {
  const matches: { kind: 'skill' | 'reference'; body: string }[] = []
  const skill = input.skillsIndex.find((s) => s.name === name)
  if (skill) matches.push({ kind: 'skill', body: skill.content })
  const ref = input.referencesIndex.find((r) => r.name === name)
  if (ref) matches.push({ kind: 'reference', body: ref.content })
  return matches
}

export function buildMaterializePrompt(
  input: CaseDistillInput,
  dossier: Dossier,
  c: KnowledgeCandidate,
  resolve?: (id: string) => string
): string {
  const sec = (key: string): string =>
    resolve
      ? resolve(`headless.case-distill.materialize.section.${key}`)
      : MATERIALIZE_SECTIONS[key].text
  const evidence = c.evidence
    .map((p) => ({ path: p, item: resolveDossierPath(dossier, p) }))
    .filter((e) => e.item)
  const parts = [
    resolve ? resolve('headless.case-distill.materialize.contract') : MATERIALIZE_CONTRACT,
    `${sec('candidate')}\n${JSON.stringify({ kind: c.kind, type: c.type, target: c.target, title: c.title, outline: c.outline, generalization: c.generalization }, null, 2)}`,
    `${sec('evidence')}\n${JSON.stringify(evidence, null, 2)}`
  ]
  if (c.type !== 'skill-new') {
    const target = findTargetContent(input, c.type, c.target)
    parts.push(
      `${sec('target')}\n${target !== undefined ? target : '(does not exist yet — your ops create it)'}`
    )
  }
  const related = c.related
    .filter((n) => n !== c.target)
    .flatMap((n) => findAllContent(input, n).map((m) => ({ n, ...m })))
  if (related.length)
    parts.push(
      `${sec('related')}\n${related.map((r) => `## ${r.n} (${r.kind})\n\n${r.body}`).join('\n\n---\n\n')}`
    )
  parts.push(sec('output-nudge'))
  return parts.join('\n\n')
}

const OPS = new Set(['append-section', 'replace-section', 'insert-after', 'append-file'])
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function parseMaterializeOutput(
  text: string,
  type: KnowledgeCandidate['type']
): MaterializeOutput {
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
  if (!isStr(o.basis)) throw new DistillParseError('basis missing', text)
  if (type === 'skill-new') {
    if (!isStr(o.file)) throw new DistillParseError('skill-new needs "file"', text)
    return { file: o.file, basis: o.basis }
  }
  const ops: PatchOp[] = []
  if (o.ops !== undefined) {
    if (!Array.isArray(o.ops)) throw new DistillParseError('ops must be an array', text)
    for (const op of o.ops as Record<string, unknown>[]) {
      if (
        typeof op !== 'object' ||
        op === null ||
        !isStr(op.op) ||
        !OPS.has(op.op) ||
        typeof op.content !== 'string'
      )
        throw new DistillParseError(`bad op ${JSON.stringify(op)}`, text)
      ops.push({
        op: op.op as PatchOp['op'],
        ...(isStr(op.heading) ? { heading: op.heading } : {}),
        content: op.content
      })
    }
  }
  const whole = isStr(o.whole_file) ? o.whole_file : null
  const fmIn = o.frontmatter
  const frontmatter =
    typeof fmIn === 'object' &&
    fmIn !== null &&
    isStr((fmIn as Record<string, unknown>).description)
      ? { description: (fmIn as Record<string, string>).description }
      : null
  if (ops.length === 0 && !whole && !frontmatter)
    throw new DistillParseError('edit needs ops, whole_file, or frontmatter', text)
  const supersedes = Array.isArray(o.supersedes)
    ? (o.supersedes as Record<string, unknown>[])
        .filter((s) => isStr(s?.asset))
        .map((s) => ({ asset: s.asset as string, note: typeof s.note === 'string' ? s.note : '' }))
    : []
  return { ops, frontmatter, supersedes, whole_file: whole, basis: o.basis }
}

export type MaterializeResult =
  | {
      ok: true
      proposal: NonNullable<CaseDistillOutput['proposals']>[number]
      original?: string
      wholeFileUsed: boolean
    }
  | { ok: false; error: string }

export function materializeToProposal(
  input: CaseDistillInput,
  dossier: Dossier,
  c: KnowledgeCandidate,
  out: MaterializeOutput
): MaterializeResult {
  // Deduped by value, first-seen order: two dossier items commonly rest on the SAME source (a
  // root cause and the diagnostic step that established it), and the proposal's `evidence`
  // frontmatter is a list of sources for a reviewer — each one belongs in it once.
  const seenCites = new Set<string>()
  const cites: DossierCite[] = []
  for (const p of c.evidence) {
    for (const cite of resolveDossierPath(dossier, p)?.cites ?? []) {
      // Canonical key, not JSON.stringify: isCite accepts {turn, session} in either key order.
      const k =
        'finding' in cite
          ? `f:${cite.finding}`
          : 'evidence' in cite
            ? `e:${cite.evidence}`
            : `s:${cite.session}:${cite.turn}`
      if (seenCites.has(k)) continue
      seenCites.add(k)
      cites.push(cite)
    }
  }
  const evidence = JSON.stringify(cites)
  const basis = out.basis.replace(/[\r\n]+/g, ' ').trim()
  if (c.type === 'skill-new') {
    if (!out.file) return { ok: false, error: 'skill-new without file' }
    return {
      ok: true,
      proposal: {
        type: c.type,
        target: c.target,
        title: c.title,
        content: out.file,
        basis,
        evidence
      },
      wholeFileUsed: false
    }
  }
  const original = findTargetContent(input, c.type, c.target)
  if (out.whole_file) {
    return {
      ok: true,
      proposal: {
        type: c.type,
        target: c.target,
        title: c.title,
        content: out.whole_file,
        basis,
        evidence
      },
      original,
      wholeFileUsed: true
    }
  }
  const r = applyPatch(original ?? '', out.ops ?? [], out.frontmatter ?? null)
  if (!r.ok) return { ok: false, error: r.error }
  const content = original === undefined ? r.text.trimStart() : r.text
  return {
    ok: true,
    proposal: { type: c.type, target: c.target, title: c.title, content, basis, evidence },
    original,
    wholeFileUsed: false
  }
}
