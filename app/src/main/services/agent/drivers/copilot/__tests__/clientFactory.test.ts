import { describe, expect, it } from 'vitest'
import { resolveCopilotCliPath } from '../client'

/**
 * Regression cover for the Electron-only Copilot boot failure: the SDK resolves its
 * bundled CLI to the platform package's `index.js` and spawns `process.execPath` for it,
 * which in the Electron main process is `electron.exe` — it exits 0 immediately and the
 * SDK reports "CLI server exited unexpectedly with code 0". We must hand the SDK the
 * native executable instead, so no Node launcher is involved.
 */
describe('resolveCopilotCliPath', () => {
  it('resolves the platform package entry, not a .js launcher script', () => {
    const seen: string[] = []
    const got = resolveCopilotCliPath((id) => {
      seen.push(id)
      return `/pkgs/${id}/copilot.exe`
    })
    expect(got).toBe(`/pkgs/@github/copilot-${process.platform}-${process.arch}/copilot.exe`)
    expect(got?.endsWith('.js')).toBe(false)
    expect(seen[0]).toBe(`@github/copilot-${process.platform}-${process.arch}`)
  })

  it('returns null when no platform package is installed, deferring to the SDK error', () => {
    expect(
      resolveCopilotCliPath(() => {
        throw new Error('MODULE_NOT_FOUND')
      })
    ).toBeNull()
  })

  /**
   * Packaged-build regression (verified 2026-07-19 against `dist/win-unpacked`): inside an
   * asar archive `require.resolve` yields a path under `app.asar`, which Electron virtualizes
   * for `fs` but NOT for `CreateProcess` — spawning it fails ENOENT, the SDK's child dies, and
   * its jsonrpc writer floods unhandled ERR_STREAM_DESTROYED rejections. electron-builder
   * already unpacks the binary; we must point at the `app.asar.unpacked` twin.
   */
  it('rewrites an asar-internal path to its app.asar.unpacked twin', () => {
    const got = resolveCopilotCliPath(
      () => 'C:\\app\\resources\\app.asar\\node_modules\\@github\\copilot-win32-x64\\copilot.exe'
    )
    expect(got).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-win32-x64\\copilot.exe'
    )
  })

  it('leaves a path that merely contains "asar" in a directory name alone', () => {
    const got = resolveCopilotCliPath(() => '/home/asario/pkgs/copilot.exe')
    expect(got).toBe('/home/asario/pkgs/copilot.exe')
  })

  it('resolves the real installed platform binary in this workspace', () => {
    const got = resolveCopilotCliPath()
    expect(got).toBeTruthy()
    expect(got?.endsWith('.js')).toBe(false)
  })
})
