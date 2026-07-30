/**
 * The machine's git identity — the impure half of authorship (shared/authorship.ts holds the
 * pure half). git config is the source because every engineer already has one, it needs no
 * network call or extra auth, and it is the same identity that authors the commit a HiveMind
 * push creates — so the frontmatter byline and the repo's history agree.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { formatIdentity, type Identity } from '../../shared/authorship'

const execFileAsync = promisify(execFile)

export type IdentityRunner = (cmd: string, args: string[]) => Promise<string>

const defaultRun: IdentityRunner = async (cmd, args) => {
  // cwd is load-bearing, not incidental: `git config` resolves against the working directory,
  // and a repository-local [user] block beats the global one. Launch Argus from a terminal
  // sitting inside a client repo and every asset written that session would be bylined with
  // that repo's identity. os.tmpdir() is never a work tree, so resolution is deterministically
  // global — the same reason the claude driver's probe and headless spawns pin cwd: os.tmpdir().
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, cwd: os.tmpdir() })
  return stdout.trim()
}

const MAX_LEN = 100

/**
 * git config values are user-controlled text landing in a parsed YAML block. A value failing
 * any check is treated as ABSENT, never as sanitized-and-accepted — without this a `user.name`
 * containing a newline injects arbitrary frontmatter keys (`trust_tier` among them) into every
 * asset this machine writes.
 */
/**
 * `formatIdentity` emits a bare plain YAML scalar — `author: Ops: Platform <a@x>` — and skills
 * are handed to real YAML parsers (the Claude CLI, Copilot's `skillDirectories`), not only to
 * this repo's forgiving regex readers. A name carrying a mapping-value indicator, a comment
 * start, or a leading indicator character does not merely mangle the byline: it makes the WHOLE
 * frontmatter block unparseable, taking `name:` and `description:` down with it.
 *
 * Rejecting here rather than quoting on the way out keeps the on-disk format the one the spec
 * documents (and the one `parseAuthorship` and the contributor lines already share).
 */
function yamlPlainSafe(v: string): boolean {
  if (/:(\s|$)/.test(v)) return false // `Ops: Platform` — mapping values are not allowed here
  if (/(^|\s)#/.test(v)) return false // `Alex #1` — everything after it becomes a comment
  // a plain scalar may not START with an indicator; `-` and `?` only bite before a space
  return !/^[,[\]{}&*!|>'"%@`]/.test(v) && !/^[-?](\s|$)/.test(v)
}

function validName(v: string): boolean {
  return v.length > 0 && v.length <= MAX_LEN && !/[\r\n<>]/.test(v) && yamlPlainSafe(v)
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
  // Fall back to the email local part if the name is empty, too long, or not YAML-plain-safe
  if (!validName(name)) name = email.split('@')[0]
  if (!validName(name)) return null
  const id = { name, email }
  // last gate on the bytes actually emitted: the two halves are checked apart, the `author:`
  // line is what a YAML parser sees
  return yamlPlainSafe(formatIdentity(id)) ? id : null
}
