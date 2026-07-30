/**
 * The machine's git identity — the impure half of authorship (shared/authorship.ts holds the
 * pure half). git config is the source because every engineer already has one, it needs no
 * network call or extra auth, and it is the same identity that authors the commit a HiveMind
 * push creates — so the frontmatter byline and the repo's history agree.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Identity } from '../../shared/authorship'

const execFileAsync = promisify(execFile)

export type IdentityRunner = (cmd: string, args: string[]) => Promise<string>

const defaultRun: IdentityRunner = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 })
  return stdout.trim()
}

const MAX_LEN = 100

/**
 * git config values are user-controlled text landing in a parsed YAML block. A value failing
 * any check is treated as ABSENT, never as sanitized-and-accepted — without this a `user.name`
 * containing a newline injects arbitrary frontmatter keys (`trust_tier` among them) into every
 * asset this machine writes.
 */
function validName(v: string): boolean {
  return v.length > 0 && v.length <= MAX_LEN && !/[\r\n<>]/.test(v)
}
function validEmail(v: string): boolean {
  return v.length > 0 && v.length <= MAX_LEN && !/[\s<>]/.test(v)
}

let cached: Promise<Identity | null> | undefined

/** Resolved once per app run; `run` is injectable for tests. */
export function identity(run: IdentityRunner = defaultRun): Promise<Identity | null> {
  cached ??= resolve(run)
  return cached
}

/** Tests only — the cache is process-wide and would leak between cases. */
export function resetIdentityCache(): void {
  cached = undefined
}

async function resolve(run: IdentityRunner): Promise<Identity | null> {
  const get = async (key: string): Promise<string> => {
    try {
      return (await run('git', ['config', '--get', key])).trim()
    } catch {
      return ''
    }
  }
  const email = await get('user.email')
  if (!validEmail(email)) return null
  let name = await get('user.name')
  // Reject if name has forbidden characters (injection attack vector); don't fall back for these
  if (name && /[\r\n<>]/.test(name)) return null
  // Fall back to email local part if name is empty or too long
  if (!validName(name)) name = email.split('@')[0]
  return validName(name) ? { name, email } : null
}
