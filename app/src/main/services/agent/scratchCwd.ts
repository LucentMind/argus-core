import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRATCH_DIR = path.join(os.tmpdir(), 'argus-agent-cwd')

/**
 * An empty, app-owned directory to spawn agent CLIs in when there is no case to run inside
 * (auth probe, model-catalog fetch, headless one-shot).
 *
 * These three sites used to pass `os.tmpdir()` itself, for two reasons worth keeping: the temp
 * dir is never a git work tree, so `git config` resolution stays global (see authorship.ts),
 * and it is not a TCC-protected user folder, so a Finder-launched packaged build's CLI boot
 * walk prompts nothing (see argus-probe-missing-cwd-tcc).
 *
 * What it also is, on a long-lived Windows profile, is enormous — 731k top-level entries on
 * the machine this was diagnosed on. The Claude CLI walks its cwd during boot, so time-to-
 * `system/init` measured 6–17s from the temp root against a 10s probe budget, versus ~1s from
 * an empty directory: the auth probe timed out on every single run, and the settings card and
 * session chip both reported "probe timed out — is the claude CLI installed and logged in?"
 * on a perfectly healthy, logged-in CLI. A dedicated subdirectory keeps both properties above
 * and costs nothing to walk.
 *
 * Created on demand rather than once at boot — a temp sweeper may remove it between spawns.
 * A creation failure falls back to the temp root: a slow spawn beats no spawn.
 */
export function agentScratchCwd(mkdir: (dir: string) => void = defaultMkdir): string {
  try {
    mkdir(SCRATCH_DIR)
    return SCRATCH_DIR
  } catch {
    return os.tmpdir()
  }
}

function defaultMkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}
