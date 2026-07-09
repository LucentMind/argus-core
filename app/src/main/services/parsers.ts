import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BIN_NAMES =
  process.platform === 'win32'
    ? ['sample-parse.exe', 'sample-parse']
    : ['sample-parse', 'sample-parse.exe']

function firstExisting(dir: string): string | null {
  for (const name of BIN_NAMES) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Locate the sample-parse binary. Order: ARGUS_PARSE_BIN override → settings
 * (tools.parseBin) → dev cargo target next to the app root → bundled
 * extraResources → bare name on PATH.
 *
 * `envBin` means the USER-set override, captured at startup — NOT whatever
 * the app itself may have exported to process.env since then (index.ts
 * re-exports the resolved binary for spawned children, and that value must
 * never shadow settings). It defaults to the live env for callers that
 * haven't captured anything yet; callers that captured env at startup must
 * pass it explicitly (`captured ?? null`), using `null` — not `undefined` —
 * to mean "no user env", since an optional-with-undefined would silently
 * fall back to the live (possibly app-exported) value.
 */
export function resolveArgusParse(
  appRoot: string,
  settingsBin?: string,
  envBin: string | null = process.env.ARGUS_PARSE_BIN ?? null
): string | null {
  if (envBin && fs.existsSync(envBin)) return envBin

  if (settingsBin && fs.existsSync(settingsBin)) return settingsBin

  const dev = firstExisting(path.resolve(appRoot, '..', 'trace-rs', 'target', 'release'))
  if (dev) return dev

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const bundled = firstExisting(path.join(resourcesPath, 'bin'))
    if (bundled) return bundled
  }

  try {
    execFileSync('sample-parse', ['doctor'], { stdio: 'ignore', timeout: 3000 })
    return 'sample-parse'
  } catch {
    return null
  }
}
