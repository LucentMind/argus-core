import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PreflightReport } from '../../../shared/types'

const execFileAsync = promisify(execFile)

export async function runPreflight(): Promise<PreflightReport> {
  try {
    const { stdout } = await execFileAsync('sample-trace', ['doctor', '--json'], { timeout: 5000 })
    const parsed = JSON.parse(stdout) as PreflightReport
    return parsed
  } catch (err) {
    const detail =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'sample-trace not installed (pip install -e trace-tools/)'
        : (err as Error).message
    return { ok: false, checks: [{ name: 'sample-trace', ok: false, detail }] }
  }
}
