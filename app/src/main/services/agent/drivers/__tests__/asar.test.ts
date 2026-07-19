import { describe, expect, it } from 'vitest'
import { asarUnpackedPath, isInsideAsar } from '../asar'

/**
 * Packaged-build invariant (verified 2026-07-19 against `dist/win-unpacked`): Electron
 * virtualizes `app.asar` paths for `fs` but NOT for process spawning — `CreateProcess` on one
 * fails ENOENT. Every native binary we hand to an SDK must be rewritten onto its unpacked twin.
 */
describe('asarUnpackedPath', () => {
  it('rewrites a win32 asar path onto its unpacked twin', () => {
    expect(asarUnpackedPath('C:\\app\\resources\\app.asar\\node_modules\\pkg\\bin.exe')).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\pkg\\bin.exe'
    )
  })

  it('rewrites a posix asar path onto its unpacked twin', () => {
    expect(asarUnpackedPath('/opt/app/resources/app.asar/node_modules/pkg/bin')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/pkg/bin'
    )
  })

  it('leaves a non-asar path untouched, including dirs that merely contain "asar"', () => {
    expect(asarUnpackedPath('/home/asario/pkgs/bin')).toBe('/home/asario/pkgs/bin')
    expect(asarUnpackedPath('/home/me/app.asar.unpacked/bin')).toBe(
      '/home/me/app.asar.unpacked/bin'
    )
  })

  it('detects asar membership', () => {
    expect(isInsideAsar('/opt/app/resources/app.asar/node_modules/pkg/bin')).toBe(true)
    expect(isInsideAsar('C:\\app\\resources\\app.asar\\pkg\\bin.exe')).toBe(true)
    expect(isInsideAsar('/home/asario/pkgs/bin')).toBe(false)
    expect(isInsideAsar('/opt/app/resources/app.asar.unpacked/pkg/bin')).toBe(false)
  })
})
