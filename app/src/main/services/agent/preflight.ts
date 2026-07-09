import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { PreflightReport } from '../../../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Locate the directory holding the sample-trace executable so it can be
 * prepended to PATH for the app process (preflight + agent-spawned shells).
 * Order: ARGUS_TRACE_DIR override → dev venv next to the app root → null
 * (already on PATH, or genuinely missing — preflight reports either way).
 */
export function resolveTraceBinDir(appRoot: string): string | null {
  const override = process.env.ARGUS_TRACE_DIR
  if (override && fs.existsSync(override)) return override
  const venvBin = path.resolve(
    appRoot, '..', 'trace-tools', '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin'
  )
  if (fs.existsSync(venvBin)) return venvBin
  return null
}

export function ensureTraceOnPath(appRoot: string): void {
  const dir = resolveTraceBinDir(appRoot)
  if (!dir) return
  const current = process.env.PATH ?? ''
  if (!current.split(path.delimiter).includes(dir)) {
    process.env.PATH = dir + path.delimiter + current
  }
}

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
