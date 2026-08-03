import crypto from 'node:crypto'
import { RCA_CONTRACT, RCA_SECTIONS } from './contract'

/**
 * Version hash of the case-RCA prompt's STATIC parts as resolved right now — the contract
 * plus every section header, in sorted key order. The dynamic case payload is deliberately
 * excluded: it lives in the job's input_snapshot. Together (prompt_hash, input_snapshot)
 * fully identify what the model saw, because buildCaseRcaPrompt is deterministic given both.
 * Stamped at enqueue (the moment the snapshot freezes) so a later Prompts-page override
 * change cannot desynchronize hash and snapshot.
 */
export function caseRcaPromptHash(resolve?: (id: string) => string): string {
  const parts = [
    resolve ? resolve('headless.case-rca.contract') : RCA_CONTRACT,
    ...Object.keys(RCA_SECTIONS)
      .sort()
      .map((k) => (resolve ? resolve(`headless.case-rca.section.${k}`) : RCA_SECTIONS[k].text))
  ]
  return crypto
    .createHash('sha256')
    .update(parts.join('\n' + String.fromCharCode(0) + '\n'))
    .digest('hex')
    .slice(0, 12)
}
