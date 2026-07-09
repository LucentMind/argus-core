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
 */
export function resolveArgusParse(appRoot: string, settingsBin?: string): string | null {
  const env = process.env.ARGUS_PARSE_BIN
  if (env && fs.existsSync(env)) return env

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
