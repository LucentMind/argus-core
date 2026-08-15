import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../../shared/ipc'
import {
  stagePlan,
  toPlannedRows,
  type StagedPack,
  type PlannerDeps,
  type PlanRoot
} from './depPlanner'
import { applyPlan, type ApplyPlanDeps } from './depInstall'
import { inspectBundleSource } from './install'
import { stageRepoBundle } from './githubInstall'
import { parseGhRef } from './githubRef'
import type { GhClient } from './ghClient'
import type { PacksStateStore, PackSource } from './packsState'
import type { PackManifest } from './manifest'
import type { PlanResult, ApplyPlanResult } from '../../../shared/packs'

/**
 * `handle` is injected rather than importing `ipcMain`, so `packsPlanBundle`/`packsApplyPlan`'s
 * wiring — in particular the capture-and-clear race fix in the apply handler — is testable under
 * the house DI convention (never `vi.mock('electron')`; see updateIpc.ts for the same idiom).
 */
export interface HandleFn {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ipcMain.handle's own
     permissive signature (`(event: IpcMainInvokeEvent, ...args: any[]) => any`); a narrower type
     here would reject the differently-shaped listeners below (one takes a `source: string`, the
     other takes nothing). */
  (channel: string, fn: (...args: any[]) => unknown): void
}

export interface PacksPlanIpcDeps {
  resolver: PlannerDeps['resolver']
  download: PlannerDeps['download']
  /** Needed by `packsPlanRepo`, which downloads the root bundle from a GitHub release. */
  gh: GhClient
  host?: { platform: string; arch: string }
  packsState: PacksStateStore
  argusHome: string
  /** Root under which a fresh per-plan staging directory is `mkdtemp`'d, e.g. `app.getPath('temp')`. */
  tempRoot: string
  /** Injected for tests; defaults to the real installer via `applyPlan`'s own default. */
  install?: ApplyPlanDeps['install']
  /** Called once a plan finishes applying (whether or not anything installed), so the caller can
   *  broadcast `packsChanged` / mark packs touched / reindex references. */
  onApplied: (res: ApplyPlanResult) => void
}

/**
 * The staging slot, handed back so entry points that live OUTSIDE this module can plan into the
 * same slot `packsApplyPlan` drains. `PackUpdatesService` uses it: an update whose new manifest
 * declares an unsatisfied dependency stages a plan instead of refusing.
 */
export interface PlanStager {
  /**
   * Stage a plan from a root bundle that already exists somewhere on disk. The bundle is COPIED
   * into the plan's own cache directory, so the caller is free to delete its own temp directory
   * as soon as this returns — the bytes must survive until the user approves the plan, and
   * re-downloading them at approval time would be a second, unverified fetch.
   */
  stageFromBundle(root: {
    id: string
    version: string
    bundlePath: string
    pinOverride?: PackSource
    dependencies: PackManifest['dependencies']
  }): Promise<PlanResult>
}

export function registerPacksPlanIpc(handle: HandleFn, deps: PacksPlanIpcDeps): PlanStager {
  /**
   * Staging-cache ownership: this closure creates `stagedCacheDir` (a fresh `mkdtemp`'d directory
   * per plan) inside `stageInto`, and it alone is responsible for removing it — either when
   * a later plan supersedes this one, when a plan is refused, or when `packsApplyPlan` finishes
   * (success or failure). `depPlanner.ts` no longer creates or owns this directory; it only writes
   * into whatever `cacheDir` it is handed.
   */
  let stagedPlan: StagedPack[] | null = null
  let stagedCacheDir: string | null = null

  function clearStaging(): void {
    if (stagedCacheDir) fs.rmSync(stagedCacheDir, { recursive: true, force: true })
    stagedPlan = null
    stagedCacheDir = null
  }

  /**
   * The one path that stages a plan, whatever the root came from — a picked zip, a GitHub
   * release, or an update's already-downloaded bundle. `build` is handed the plan's cache
   * directory so a root that must be FETCHED lands directly in the directory whose lifetime is
   * already managed, with no second copy and no second temp dir to leak.
   *
   * Every way out of the try that is not adoption removes the directory, including `build` or
   * `stagePlan` throwing — a downloaded bundle whose manifest fails to parse makes
   * `inspectBundleSource` throw, and that must not leave downloaded bytes on disk forever.
   */
  async function stageInto(
    build: (
      cacheDir: string
    ) => Promise<{ ok: true; root: PlanRoot } | Extract<PlanResult, { ok: false }>>
  ): Promise<PlanResult> {
    // A new plan supersedes whatever the previous one staged — remove its cache dir too, not just
    // the in-memory reference, or a superseded plan's bytes would sit on disk forever.
    clearStaging()
    const cacheDir = fs.mkdtempSync(path.join(deps.tempRoot, 'argus-pack-plan-'))
    let adopted = false
    try {
      const built = await build(cacheDir)
      if (!built.ok) return built
      const result = await stagePlan(
        {
          resolver: deps.resolver,
          download: deps.download,
          inspect: (bundlePath) =>
            inspectBundleSource(bundlePath, { installed: deps.packsState.list() }),
          installed: deps.packsState.list(),
          pins: Object.fromEntries(
            Object.keys(deps.packsState.list()).map((id) => [id, deps.packsState.getSource(id)])
          ),
          argusHome: deps.argusHome,
          cacheDir
        },
        built.root
      )
      if (!result.ok) return result // refused — nothing to stage; cleaned up in `finally` below
      stagedPlan = result.packs
      stagedCacheDir = cacheDir
      adopted = true
      // Main keeps the staged packs (bundlePath, source); the renderer gets IPC-safe rows only.
      return { ok: true, packs: toPlannedRows(result.packs) }
    } finally {
      if (!adopted) fs.rmSync(cacheDir, { recursive: true, force: true })
    }
  }

  handle(IPC.packsPlanBundle, async (_e: unknown, source: string): Promise<PlanResult> =>
    stageInto(async () => {
      const inspected = await inspectBundleSource(source, { installed: deps.packsState.list() })
      return {
        ok: true,
        root: {
          id: inspected.id,
          version: inspected.version,
          bundlePath: source,
          source: null,
          dependencies: inspected.rawDependencies
        }
      }
    })
  )

  /**
   * The GitHub entry point. Before this existed, installing from a repository called `installPack`
   * directly and a pack declaring dependencies was refused with "requires <id>" no matter what
   * sources those dependencies named. Staging the downloaded root here routes it through the same
   * planner the local-bundle picker uses.
   *
   * A staging refusal (bad ref, checksum mismatch, a manifest naming another repo as its update
   * home) is reported as a plan refusal with code `'bundle'` rather than a thrown error, so the
   * renderer renders one sentence for every way a plan can fail.
   */
  handle(IPC.packsPlanRepo, async (_e: unknown, ref: string, packId: string): Promise<PlanResult> =>
    stageInto(async (cacheDir) => {
      const parsed = parseGhRef(ref)
      if (!parsed) {
        return { ok: false, code: 'bundle', error: 'Enter a repository as owner/repo.' }
      }
      const staged = await stageRepoBundle(
        { gh: deps.gh, host: deps.host },
        parsed,
        packId,
        cacheDir
      )
      if (!staged.ok) return { ok: false, code: 'bundle', error: staged.error }
      return {
        ok: true,
        root: {
          id: staged.inspected.id,
          version: staged.inspected.version,
          bundlePath: staged.zipPath,
          // The repo the bytes came from, so a dependency of this pack that names the same repo
          // resolves against it, and so the root records it as its own pin (`pinOverride`).
          source: {
            kind: 'github',
            host: staged.pin.host,
            owner: staged.pin.owner,
            repo: staged.pin.repo
          },
          pinOverride: staged.pin,
          dependencies: staged.inspected.rawDependencies
        }
      }
    })
  )

  handle(IPC.packsApplyPlan, async (): Promise<ApplyPlanResult> => {
    // Claim the plan (and its cache dir) before the first await: capture-and-clear is atomic on a
    // single-threaded event loop, so a second invocation (a double-clicked button) sees null and
    // cannot double-install, and a plan staged WHILE this runs is not clobbered by a trailing reset.
    const plan = stagedPlan
    const cacheDir = stagedCacheDir
    stagedPlan = null
    stagedCacheDir = null
    if (!plan) {
      return { installed: [], failed: { id: '', error: 'no plan staged' }, relaunchRequired: false }
    }
    const res = await applyPlan(
      {
        argusHome: deps.argusHome,
        state: deps.packsState,
        host: deps.host,
        existingPins: Object.fromEntries(
          Object.keys(deps.packsState.list()).map((id) => [id, deps.packsState.getSource(id)])
        ),
        install: deps.install
      },
      plan
    )
    // The staging cache's job — holding verified bytes until approval — is done either way, so it
    // is removed here regardless of whether every pack installed.
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true })
    deps.onApplied(res)
    return res
  })

  return {
    async stageFromBundle(root): Promise<PlanResult> {
      return stageInto(async (cacheDir) => {
        const copied = path.join(cacheDir, `${root.id}-root${path.extname(root.bundlePath)}`)
        fs.copyFileSync(root.bundlePath, copied)
        return {
          ok: true,
          root: {
            id: root.id,
            version: root.version,
            bundlePath: copied,
            // The caller supplies the exact pin (`pinOverride`); there is no declared source to
            // derive, and leaving it null keeps `pinFor` out of the decision entirely.
            source: null,
            pinOverride: root.pinOverride,
            dependencies: root.dependencies
          }
        }
      })
    }
  }
}
