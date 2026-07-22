import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ShellPathDeps {
  run?: (shell: string, args: string[]) => Promise<string>
  platform?: NodeJS.Platform
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
}

const defaultRun = async (shell: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(shell, args, { timeout: 3000 })
  return stdout
}

/**
 * Appends each `captured` entry not already in `current`, preserving `current`'s
 * order and entries first — hydration can add lookup paths but never break one
 * that already works. Empty segments are dropped; ':' is correct because
 * hydration only runs on darwin/linux.
 */
export function mergePath(current: string, captured: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of [...current.split(':'), ...captured.split(':')]) {
    if (seg && !seen.has(seg)) {
      seen.add(seg)
      out.push(seg)
    }
  }
  return out.join(':')
}

/**
 * Packaged macOS/Linux apps launched from Finder/Dock inherit the minimal
 * launchd PATH, so Homebrew-installed CLIs (gh, ...) spawn as ENOENT. Capture
 * the login shell's PATH once at startup and merge it into process.env.PATH.
 * Any failure (spawn error, timeout, empty output) is a no-op.
 */
export async function hydratePathFromLoginShell(deps: ShellPathDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') return
  const isPackaged = deps.isPackaged ?? (await import('electron')).app.isPackaged
  if (!isPackaged) return
  const env = deps.env ?? process.env
  const shell = env.SHELL || '/bin/zsh'
  const run = deps.run ?? defaultRun
  try {
    // -ilc: interactive + login so .zprofile/.zshrc/.bash_profile (brew shellenv) are sourced.
    const captured = (
      await run(shell, ['-ilc', 'command -v printf >/dev/null 2>&1 && printf %s "$PATH"'])
    ).trim()
    if (!captured) return
    env.PATH = mergePath(env.PATH ?? '', captured)
  } catch {
    // Failure = no-op: worst case equals today's behavior.
  }
}
