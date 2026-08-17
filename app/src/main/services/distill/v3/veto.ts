import type { CaseDistillInput } from '../../../../shared/distill'
import type { Dossier, KnowledgeCandidate, PreStageDrop } from '../../../../shared/distillV3'
import { ASSET_NAME_RE } from '../../../../shared/assetValidation'
import { RESOLUTION_CAPS } from '../staging'
import { resolveDossierPath } from './dossier'

/** Deterministic gate between candidates and materialize. Every drop carries a reason that is
 *  persisted on the job. Order: per-candidate checks in table order, then intra-batch dedupe,
 *  then the resolution cap over the survivors sorted by confidence (desc, stable). */
export function vetoCandidates(
  candidates: KnowledgeCandidate[],
  dossier: Dossier,
  input: CaseDistillInput
): { kept: KnowledgeCandidate[]; dropped: PreStageDrop[] } {
  const skills = new Set(input.skillsIndex.map((s) => s.name))
  const refTier = new Map(input.referencesIndex.map((r) => [r.name, r.tier]))
  const captured = new Set(input.alreadyCaptured.proposals.map((p) => `${p.type} ${p.target}`))
  const dropped: PreStageDrop[] = []
  const drop = (c: KnowledgeCandidate, reason: PreStageDrop['reason']): void => {
    dropped.push({ type: c.type, target: c.target, title: c.title, reason })
  }
  const pass1: KnowledgeCandidate[] = []
  for (const c of candidates) {
    if (
      c.evidence.length === 0 ||
      c.evidence.some((p) => resolveDossierPath(dossier, p) === null)
    ) {
      drop(c, 'malformed')
      continue
    }
    if (!ASSET_NAME_RE.test(c.target)) {
      drop(c, 'bad-name')
      continue
    }
    if (c.type === 'skill-edit' && !skills.has(c.target)) {
      drop(c, 'unknown-target')
      continue
    }
    if (c.type === 'skill-new' && skills.has(c.target)) {
      drop(c, 'target-exists')
      continue
    }
    if (c.type === 'reference-edit' && refTier.get(c.target) === 'confluence') {
      drop(c, 'confluence-tier')
      continue
    }
    if (captured.has(`${c.type} ${c.target}`)) {
      drop(c, 'duplicate')
      continue
    }
    const isSkill = c.type === 'skill-new' || c.type === 'skill-edit'
    if ((c.kind === 'fact' && isSkill) || (c.kind === 'procedure' && !isSkill)) {
      drop(c, 'kind-type-mismatch')
      continue
    }
    pass1.push(c)
  }
  const sorted = [...pass1].sort((a, b) => b.confidence - a.confidence)
  const seen = new Set<string>()
  const deduped: KnowledgeCandidate[] = []
  for (const c of sorted) {
    const k = `${c.type} ${c.target}`
    if (seen.has(k)) {
      drop(c, 'duplicate')
      continue
    }
    seen.add(k)
    deduped.push(c)
  }
  const resolution =
    input.caseMeta.resolution ?? (input.caseMeta.status === 'open' ? 'open' : 'solved')
  const cap = RESOLUTION_CAPS[resolution] ?? 1
  for (const c of deduped.slice(cap)) drop(c, 'cap')
  return { kept: deduped.slice(0, cap), dropped }
}
