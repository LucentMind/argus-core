import semver from 'semver'
import { PACK_API_VERSION } from './manifest'

/** True when a pack's declared `argusApi` range includes the API this Core implements. */
export function isApiCompatible(argusApi: string): boolean {
  return semver.satisfies(`${PACK_API_VERSION}.0.0`, argusApi)
}

const OS_TO_NODE: Record<string, 'win32' | 'darwin' | 'linux'> = {
  mac: 'darwin',
  win: 'win32',
  linux: 'linux'
}
const ARCH_TO_NODE: Record<string, 'x64' | 'arm64'> = {
  x64: 'x64',
  arm64: 'arm64'
}
const NODE_TO_OS: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' }

function parts(platform: string): [string, string] | null {
  const m = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(platform)
  return m ? [m[1], m[2]] : null
}

export function osOf(platform: string): 'win32' | 'darwin' | 'linux' | null {
  const p = parts(platform)
  return p ? (OS_TO_NODE[p[0]] ?? null) : null
}

export function archOf(platform: string): 'x64' | 'arm64' | null {
  const p = parts(platform)
  return p ? (ARCH_TO_NODE[p[1]] ?? null) : null
}

export function platformMatchesHost(
  platform: string | undefined,
  host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }
): boolean {
  if (!platform) return false
  return osOf(platform) === host.platform && archOf(platform) === host.arch
}

/** Host as an `<os>-<arch>` pack string for error messages (e.g. 'win-x64'). */
export function describeHost(
  host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }
): string {
  return `${NODE_TO_OS[host.platform] ?? host.platform}-${host.arch}`
}
