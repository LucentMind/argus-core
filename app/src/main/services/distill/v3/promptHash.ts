import crypto from 'node:crypto'
import { DOSSIER_CONTRACT, DOSSIER_SECTIONS } from './dossier'
import { SUMMARY_CONTRACT, SUMMARY_SECTIONS } from './summary'
import { CANDIDATES_CONTRACT, CANDIDATES_SECTIONS } from './candidates'
import { MATERIALIZE_CONTRACT, MATERIALIZE_SECTIONS } from './materialize'
import { DISTILL_TOOL_DESCRIPTORS } from '../worldTools'
import { PTC_STUB_VERSION } from '../../ptc/stub'

export const V3_STAGES = ['dossier', 'summary', 'candidates', 'materialize'] as const
export type V3Stage = (typeof V3_STAGES)[number]

const STATIC: Record<V3Stage, { contract: string; sections: Record<string, { text: string }> }> = {
  dossier: { contract: DOSSIER_CONTRACT, sections: DOSSIER_SECTIONS },
  summary: { contract: SUMMARY_CONTRACT, sections: SUMMARY_SECTIONS },
  candidates: { contract: CANDIDATES_CONTRACT, sections: CANDIDATES_SECTIONS },
  materialize: { contract: MATERIALIZE_CONTRACT, sections: MATERIALIZE_SECTIONS }
}

const digest = (parts: string[]): string =>
  crypto
    .createHash('sha256')
    .update(parts.join('\n' + String.fromCharCode(0) + '\n'))
    .digest('hex')
    .slice(0, 12)

/** Static-part hash of one stage's prompt as resolved right now (contract + sorted section
 *  headers; the dossier stage also folds in the tool surface, exactly as v2's hash does). */
export function stagePromptHash(stage: V3Stage, resolve?: (id: string) => string): string {
  const res = (id: string, dflt: string): string => resolve?.(id) ?? dflt
  const s = STATIC[stage]
  const parts = [
    res(`headless.case-distill.${stage}.contract`, s.contract),
    ...Object.keys(s.sections)
      .sort()
      .map((k) => res(`headless.case-distill.${stage}.section.${k}`, s.sections[k].text))
  ]
  if (stage === 'dossier')
    parts.push(JSON.stringify(DISTILL_TOOL_DESCRIPTORS), `ptc-stub:${PTC_STUB_VERSION}`)
  return digest(parts)
}

/** The job-level `prompt_hash` for a v3 run: hash of the four stage hashes, prefixed so it can
 *  never collide with a v2 hash of the same length. */
export function caseDistillPipelineHash(resolve?: (id: string) => string): string {
  return digest(['v3', ...V3_STAGES.map((s) => stagePromptHash(s, resolve))])
}
