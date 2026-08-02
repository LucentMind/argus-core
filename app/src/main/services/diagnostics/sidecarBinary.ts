import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve the resource-monitor sidecar executable.
 *
 * Precedence: ARGUS_RESOURCE_MONITOR_PATH -> packaged <resourcesPath>/resource-monitor
 * -> a local cargo build in a dev checkout -> null.
 *
 * Returns null rather than throwing for every miss, including an unsupported
 * platform. A missing sidecar degrades the Diagnostics page to Electron metrics
 * only; it must never prevent the app from starting.
 */
export function resolveSidecarBinary(opts: {
  repoRoot: string
  resourcesPath?: string
  platform?: NodeJS.Platform
}): string | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32' && platform !== 'darwin') return null

  const exe = platform === 'win32' ? 'argus-resource-monitor.exe' : 'argus-resource-monitor'
  const archKey = platform === 'win32' ? 'win32-x64' : 'darwin-universal'

  const override = process.env.ARGUS_RESOURCE_MONITOR_PATH
  if (override) return fs.existsSync(override) ? override : null

  const candidates: string[] = []
  if (opts.resourcesPath) {
    candidates.push(path.join(opts.resourcesPath, 'resource-monitor', archKey, exe))
  }
  candidates.push(
    path.join(opts.repoRoot, 'resources', 'resource-monitor', archKey, exe),
    path.join(opts.repoRoot, 'native', 'resource-monitor', 'target', 'release', exe),
    path.join(opts.repoRoot, 'native', 'resource-monitor', 'target', 'debug', exe)
  )

  return candidates.find((c) => fs.existsSync(c)) ?? null
}
