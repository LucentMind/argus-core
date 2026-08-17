import crypto from 'node:crypto'
import { CASE_DISTILL_CONTRACT, CASE_DISTILL_SECTIONS } from './contract'
import { DISTILL_TOOL_DESCRIPTORS } from './worldTools'
import { PTC_STUB_VERSION } from '../ptc/stub'

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
  // v2 (Task 9): the agentic distiller's tool surface and PTC stub contract are as much a part
  // of "what the model saw" as the text prompt — a description-string edit or a stub-version
  // bump must widen the hash the same way a contract edit does.
  parts.push(JSON.stringify(DISTILL_TOOL_DESCRIPTORS), `ptc-stub:${PTC_STUB_VERSION}`)
  return crypto
    .createHash('sha256')
    .update(parts.join('\n' + String.fromCharCode(0) + '\n'))
    .digest('hex')
    .slice(0, 12)
}
