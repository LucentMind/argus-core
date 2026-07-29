import fs from 'node:fs'
import path from 'node:path'
import type { EvalCaseResult } from './run'

export function writeReport(
  outDir: string,
  results: EvalCaseResult[]
): { reportPath: string; detailsPath: string } {
  fs.mkdirSync(outDir, { recursive: true })
  const verdicts = results.flatMap((r) => r.itemVerdicts.map((v) => ({ ...v, caseSlug: r.caseSlug, jobId: r.jobId })))
  const count = (k: string): number => verdicts.filter((v) => v.verdict.verdict === k).length
  const parse = (k: EvalCaseResult['parseOutcome']): number => results.filter((r) => r.parseOutcome === k).length
  const byTag = new Map<string, { improved: number; total: number }>()
  for (const v of verdicts) {
    if (v.item.outcome !== 'rejected') continue
    const tag = v.item.rejectReason ?? 'untagged'
    const e = byTag.get(tag) ?? { improved: 0, total: 0 }
    e.total++
    if (v.verdict.verdict === 'improved') e.improved++
    byTag.set(tag, e)
  }
  const needsHuman = verdicts.filter((v) => v.verdict.verdict === 'needs-human')
  const md = [
    '# Distill-eval report',
    '',
    `Cases: ${results.length} (${results.filter((r) => r.reused).length} reused baseline output — prompt unchanged for them)`,
    `Parse: ok ${parse('ok')} · improved ${parse('parse-improved')} · REGRESSED ${parse('parse-regressed')} · still-failing ${parse('still-failing')}`,
    `Item verdicts: improved ${count('improved')} · unchanged ${count('unchanged')} · regressed ${count('regressed')} · needs-human ${count('needs-human')}`,
    '',
    '## By reject tag (improved / total)',
    ...[...byTag.entries()].map(([tag, e]) => `- ${tag}: ${e.improved}/${e.total}`),
    '',
    '## Needs human review (read these first)',
    ...needsHuman.map((v) => `- [${v.caseSlug} #${v.jobId}] ${v.item.title}: ${v.verdict.reason}`),
    ''
  ].join('\n')
  const reportPath = path.join(outDir, 'report.md')
  const detailsPath = path.join(outDir, 'details.jsonl')
  fs.writeFileSync(reportPath, md)
  fs.writeFileSync(detailsPath, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''))
  return { reportPath, detailsPath }
}
