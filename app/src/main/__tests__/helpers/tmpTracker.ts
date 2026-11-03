import type fsType from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Suite-wide temp-dir janitor.
 *
 * Hundreds of test files do `fs.mkdtempSync(path.join(os.tmpdir(), 'argus-…'))`
 * for an isolated ARGUS_HOME, and dozens never remove it; even the ones that do
 * can skip their afterEach when a test throws early, or hit EBUSY on Windows
 * while a SQLite handle is still open. Over months that left ~1.2 million
 * `argus-*` directories in %TEMP% on the maintainer's machine.
 *
 * `install()` wraps the three mkdtemp entry points on the given fs object and
 * records every directory they create under `tmpRoot`. `cleanup()` removes
 * what is still there, best-effort: a removal failure is swallowed so the
 * janitor can never turn a green file red. vitest.setup.ts installs one per
 * worker and runs cleanup in afterAll of every test file.
 */
export interface TmpTracker {
  /** Directories created under tmpRoot since install (or the last cleanup). */
  readonly paths: Set<string>
  install(): void
  uninstall(): void
  cleanup(): void
}

type FsLike = Pick<typeof fsType, 'mkdtempSync' | 'mkdtemp' | 'rmSync'> & {
  promises: Pick<typeof fsType.promises, 'mkdtemp'>
}

export function createTmpTracker(fs: FsLike, tmpRoot: string = os.tmpdir()): TmpTracker {
  const paths = new Set<string>()
  const root = path.resolve(tmpRoot)
  let originals: {
    mkdtempSync: FsLike['mkdtempSync']
    mkdtemp: FsLike['mkdtemp']
    pMkdtemp: FsLike['promises']['mkdtemp']
  } | null = null

  const isUnderRoot = (p: string): boolean => {
    const rel = path.relative(root, path.resolve(p))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  const record = (dir: unknown): void => {
    if (typeof dir === 'string' && isUnderRoot(dir)) paths.add(dir)
  }

  return {
    paths,
    install() {
      if (originals) return
      const mkdtempSync = fs.mkdtempSync
      const mkdtemp = fs.mkdtemp
      const pMkdtemp = fs.promises.mkdtemp
      originals = { mkdtempSync, mkdtemp, pMkdtemp }

      fs.mkdtempSync = ((...args: Parameters<typeof mkdtempSync>) => {
        const dir = mkdtempSync(...args)
        record(dir)
        return dir
      }) as typeof mkdtempSync

      fs.mkdtemp = ((...args: unknown[]) => {
        const cb = args[args.length - 1]
        if (typeof cb === 'function') {
          args[args.length - 1] = (err: unknown, dir: unknown) => {
            if (!err) record(dir)
            ;(cb as (e: unknown, d: unknown) => void)(err, dir)
          }
        }
        return (mkdtemp as unknown as (...a: unknown[]) => unknown)(...args)
      }) as typeof mkdtemp

      fs.promises.mkdtemp = (async (...args: Parameters<typeof pMkdtemp>) => {
        const dir = await pMkdtemp(...args)
        record(dir)
        return dir
      }) as typeof pMkdtemp
    },
    uninstall() {
      if (!originals) return
      fs.mkdtempSync = originals.mkdtempSync
      fs.mkdtemp = originals.mkdtemp
      fs.promises.mkdtemp = originals.pMkdtemp
      originals = null
    },
    cleanup() {
      for (const dir of paths) {
        try {
          // maxRetries covers the Windows EBUSY/EPERM window right after a handle closes.
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        } catch {
          // Best effort: a dir we cannot remove (handle still open) is the next
          // run's problem, never this file's failure.
        }
      }
      paths.clear()
    }
  }
}
