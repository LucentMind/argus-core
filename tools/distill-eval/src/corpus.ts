import fs from 'node:fs'
import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'

/** Load an exported NDJSON corpus. Throws naming the 1-based line on any malformed line. */
export function loadCorpus(filePath: string): DistillEvalBundleLine[] {
  const out: DistillEvalBundleLine[] = []
  const rawLines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  rawLines.forEach((raw, i) => {
    if (!raw.trim()) return
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      throw new Error(`corpus line ${i + 1}: invalid JSON (${(e as Error).message})`)
    }
    const line = obj as DistillEvalBundleLine
    if (typeof line?.job?.id !== 'number' || typeof line.job.inputSnapshot !== 'object' || line.job.inputSnapshot === null) {
      throw new Error(`corpus line ${i + 1}: missing job.id or job.inputSnapshot`)
    }
    out.push(line)
  })
  return out
}
