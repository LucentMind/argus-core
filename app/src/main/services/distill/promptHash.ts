import crypto from 'node:crypto'
import { CASE_DISTILL_CONTRACT, CASE_DISTILL_SECTIONS } from './contract'

/**
 * Version hash of the case-distill prompt's STATIC parts as resolved right now — the
 * contract plus every section header, in sorted key order. The dynamic case payload is
 * deliberately excluded: it lives in the job's input_snapshot. Together (prompt_hash,
 * input_snapshot) fully identify what the model saw, because buildCaseDistillPrompt is
 * deterministic given both. Stamped at enqueue (the moment the snapshot freezes) so a
 * later Prompts-page override change cannot desynchronize hash and snapshot.
 */
export function caseDistillPromptHash(resolve?: (id: string) => string): string {
  const parts = [
    resolve ? resolve('headless.case-distill.contract') : CASE_DISTILL_CONTRACT,
    ...Object.keys(CASE_DISTILL_SECTIONS)
      .sort()
      .map((k) =>
        resolve ? resolve(`headless.case-distill.section.${k}`) : CASE_DISTILL_SECTIONS[k].text
      )
  ]
  return crypto
    .createHash('sha256')
    .update(parts.join('\n' + String.fromCharCode(0) + '\n'))
    .digest('hex')
    .slice(0, 12)
}
