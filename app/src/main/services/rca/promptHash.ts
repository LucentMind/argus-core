import crypto from 'node:crypto'
import { RCA_CONTRACT, RCA_SECTIONS } from './contract'
import type { RcaTemplate } from '../../../shared/rcaTemplate'

/**
 * Version hash of the case-RCA prompt's STATIC parts as resolved right now — the contract,
 * every section header, and the template's section briefs. The dynamic case payload is
 * deliberately excluded: it lives in the job's input_snapshot. Together (prompt_hash,
 * input_snapshot, template_snapshot) fully identify what the model saw, because
 * buildCaseRcaPrompt is deterministic given all three. Stamped at enqueue (the moment the
 * snapshots freeze) so a later Prompts-page or template edit cannot desynchronize them.
 *
 * Only what actually REACHES the model is hashed: enabled narrative sections' id, heading and
 * instruction. A claims section's heading is a render-time label the model never sees, so
 * renaming one must not invalidate the hash.
 */
export function caseRcaPromptHash(
  resolve: ((id: string) => string) | undefined,
  template: RcaTemplate
): string {
  const briefs = [...template.exec, ...template.tech]
    .filter((s) => s.enabled && s.kind === 'narrative')
    .map((s) => `${s.id}${s.heading}${s.instruction ?? ''}`)
  const parts = [
    resolve ? resolve('headless.case-rca.contract') : RCA_CONTRACT,
    ...Object.keys(RCA_SECTIONS)
      .sort()
      .map((k) => (resolve ? resolve(`headless.case-rca.section.${k}`) : RCA_SECTIONS[k].text)),
    ...briefs
  ]
  return crypto
    .createHash('sha256')
    .update(parts.join('\n' + String.fromCharCode(0) + '\n'))
    .digest('hex')
    .slice(0, 12)
}
