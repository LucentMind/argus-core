import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SourceControlStatus } from '../../shared/sourcecontrol'

const execFileAsync = promisify(execFile)

export type ExecLike = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string; stderr: string }>

/** gh CLI status for the Source Control section. Never throws. */
export async function ghStatus(
  exec: ExecLike = (c, a, o) => execFileAsync(c, a, o)
): Promise<SourceControlStatus> {
  let version: string
  try {
    const { stdout } = await exec('gh', ['--version'], { timeout: 10000 })
    version = stdout.split('\n')[0].trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        installed: false,
        version: null,
        authenticated: false,
        login: null,
        detail: 'gh not installed'
      }
    return {
      installed: false,
      version: null,
      authenticated: false,
      login: null,
      detail: (err as Error).message
    }
  }
  try {
    const { stdout, stderr } = await exec('gh', ['auth', 'status'], { timeout: 10000 })
    const text = stdout + stderr
    const m = text.match(/Logged in to (\S+) account (\S+)/)
    if (m)
      return {
        installed: true,
        version,
        authenticated: true,
        login: m[2],
        detail: `Logged in to ${m[1]} account ${m[2]}`
      }
    return { installed: true, version, authenticated: false, login: null, detail: 'not logged in' }
  } catch {
    return { installed: true, version, authenticated: false, login: null, detail: 'not logged in' }
  }
}
