/**
 * asar path helpers for spawning bundled native binaries.
 *
 * Electron virtualizes `app.asar` paths for `fs` — `existsSync` on one returns true — but NOT
 * for process spawning: `CreateProcess`/`exec` sees no such file and fails ENOENT (verified
 * 2026-07-19 against `dist/win-unpacked`). electron-builder already unpacks native binaries to
 * an `app.asar.unpacked` twin, so anything we hand to an SDK as an executable path must be
 * rewritten. Both bundled agent CLIs (Copilot, Claude) hit this; the failures are opaque —
 * Copilot floods `ERR_STREAM_DESTROYED` from its jsonrpc writer, Claude misreports it as a
 * libc mismatch.
 */

const ASAR_SEGMENT = /([\\/])app\.asar([\\/])/

/** True when the path points inside an asar archive (not its `.unpacked` twin). */
export function isInsideAsar(p: string): boolean {
  return ASAR_SEGMENT.test(p)
}

/** Map a path inside an asar archive onto its unpacked twin; other paths pass through. */
export function asarUnpackedPath(p: string): string {
  return p.replace(ASAR_SEGMENT, '$1app.asar.unpacked$2')
}
