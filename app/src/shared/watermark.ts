/** One destination's watermark configuration (`settings.watermark.jira` / `.github`). */
export interface WatermarkTarget {
  enabled: boolean
  text: string
}

/**
 * Appends `cfg.text` to a composed comment body as a Markdown footer.
 *
 * Pure and total — no I/O, cannot throw. Lives in `shared/` so it carries no Electron
 * dependency and both the Jira (`rca/post.ts`) and GitHub (`agent/reviewWrites.ts`) seams
 * can use the identical rules.
 *
 * The already-ends-with check is what makes the retry paths safe: `postRcaReport` re-runs
 * against a job row whose comment failed, and `postReviewComment` retries as a PR-level
 * comment after a 422, so one logical post can hand the same body here twice.
 */
export function applyWatermark(body: string, cfg: WatermarkTarget): string {
  const mark = cfg.text.trim()
  // An enabled watermark with empty text must not append a trailing blank line.
  if (!cfg.enabled || mark === '') return body
  const base = body.replace(/\s+$/, '')
  if (base.endsWith(mark)) return body
  return `${base}\n\n${mark}`
}
