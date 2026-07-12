import { execFileSync } from 'node:child_process'

/**
 * Strip com.apple.quarantine from a freshly-unpacked bundle so Gatekeeper doesn't
 * kill -9 an unsigned frozen binary on first exec. macOS-only; best-effort.
 */
export function stripQuarantine(
  dir: string,
  deps: { platform?: string; run?: (cmd: string, args: string[]) => void } = {}
): void {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return
  const run =
    deps.run ?? ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 }))
  try {
    run('xattr', ['-dr', 'com.apple.quarantine', dir])
  } catch {
    /* best-effort — a missing xattr or an un-quarantined tree must not abort the install */
  }
}
