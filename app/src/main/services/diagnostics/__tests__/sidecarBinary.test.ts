import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSidecarBinary } from '../sidecarBinary'

let tmp: string

function touch(p: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  return p
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sidecar-'))
  delete process.env.ARGUS_RESOURCE_MONITOR_PATH
})

afterEach(() => {
  delete process.env.ARGUS_RESOURCE_MONITOR_PATH
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveSidecarBinary', () => {
  it('returns null on an unsupported platform rather than throwing', () => {
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'linux' })).toBeNull()
  })

  it('returns null when nothing is on disk', () => {
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBeNull()
  })

  it('prefers the env override over everything else', () => {
    const override = touch(path.join(tmp, 'custom', 'monitor.exe'))
    touch(
      path.join(tmp, 'resources', 'resource-monitor', 'win32-x64', 'argus-resource-monitor.exe')
    )
    process.env.ARGUS_RESOURCE_MONITOR_PATH = override
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBe(override)
  })

  it('an invalid override disables the sidecar rather than falling back', () => {
    // Create a valid packaged binary that would normally be found
    touch(
      path.join(tmp, 'resources', 'resource-monitor', 'win32-x64', 'argus-resource-monitor.exe')
    )

    // Set an invalid override
    process.env.ARGUS_RESOURCE_MONITOR_PATH = path.join(tmp, 'nope.exe')

    // Should return null (short-circuit), not fall back to the packaged binary
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBeNull()
  })

  it('finds the packaged binary under resourcesPath', () => {
    const packaged = touch(
      path.join(tmp, 'res', 'resource-monitor', 'win32-x64', 'argus-resource-monitor.exe')
    )
    expect(
      resolveSidecarBinary({
        repoRoot: tmp,
        resourcesPath: path.join(tmp, 'res'),
        platform: 'win32'
      })
    ).toBe(packaged)
  })

  it('finds a dev-checkout build staged under app/resources by build-resource-monitor.mjs', () => {
    const staged = touch(
      path.join(
        tmp,
        'app',
        'resources',
        'resource-monitor',
        'win32-x64',
        'argus-resource-monitor.exe'
      )
    )
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBe(staged)
  })

  it('prefers the staged app/resources build over a raw cargo target/release build', () => {
    touch(
      path.join(
        tmp,
        'native',
        'resource-monitor',
        'target',
        'release',
        'argus-resource-monitor.exe'
      )
    )
    const staged = touch(
      path.join(
        tmp,
        'app',
        'resources',
        'resource-monitor',
        'win32-x64',
        'argus-resource-monitor.exe'
      )
    )
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBe(staged)
  })

  it('falls back to a local cargo release build in a dev checkout', () => {
    const dev = touch(
      path.join(
        tmp,
        'native',
        'resource-monitor',
        'target',
        'release',
        'argus-resource-monitor.exe'
      )
    )
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBe(dev)
  })

  it('prefers a release build over a debug build', () => {
    touch(
      path.join(tmp, 'native', 'resource-monitor', 'target', 'debug', 'argus-resource-monitor.exe')
    )
    const release = touch(
      path.join(
        tmp,
        'native',
        'resource-monitor',
        'target',
        'release',
        'argus-resource-monitor.exe'
      )
    )
    expect(resolveSidecarBinary({ repoRoot: tmp, platform: 'win32' })).toBe(release)
  })

  it('uses the darwin-universal directory and no .exe suffix on macOS', () => {
    const packaged = touch(
      path.join(tmp, 'res', 'resource-monitor', 'darwin-universal', 'argus-resource-monitor')
    )
    expect(
      resolveSidecarBinary({
        repoRoot: tmp,
        resourcesPath: path.join(tmp, 'res'),
        platform: 'darwin'
      })
    ).toBe(packaged)
  })
})
