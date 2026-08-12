import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../../shared/ipc'
import { stagePlan, toPlannedRows, type StagedPack, type PlannerDeps } from './depPlanner'
import { applyPlan, type ApplyPlanDeps } from './depInstall'
import { inspectBundleSource } from './install'
import type { PacksStateStore } from './packsState'
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

export function registerPacksPlanIpc(handle: HandleFn, deps: PacksPlanIpcDeps): void {
  /**
   * Staging-cache ownership: this closure creates `stagedCacheDir` (a fresh `mkdtemp`'d directory
   * per plan) inside `packsPlanBundle`, and it alone is responsible for removing it — either when
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

  handle(IPC.packsPlanBundle, async (_e: unknown, source: string): Promise<PlanResult> => {
    // A new plan supersedes whatever the previous one staged — remove its cache dir too, not just
    // the in-memory reference, or a superseded plan's bytes would sit on disk forever.
    clearStaging()
    // Inspect the root BEFORE creating the staging dir: a malformed root bundle makes
    // `inspectBundleSource` throw, and there is nothing yet to stage, so no dir should exist to
    // leak.
    const inspected = await inspectBundleSource(source, { installed: deps.packsState.list() })
    const cacheDir = fs.mkdtempSync(path.join(deps.tempRoot, 'argus-pack-plan-'))
    // `cacheDir`'s lifetime from here on: this attempt owns it until `stagePlan` succeeds and it
    // is adopted into `stagedCacheDir` below — from that point `clearStaging`/`packsApplyPlan` own
    // it instead. Every OTHER way out of this try (a refusal, or `stagePlan` throwing — e.g. a
    // downloaded dependency bundle whose manifest fails to parse; `depPlanner.ts`'s
    // `deps.inspect(bundlePath)` call is not itself try-wrapped) means adoption never happened, so
    // the `finally` below removes it instead of leaving it, possibly still holding downloaded
    // bytes, on disk forever.
    let adopted = false
    try {
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
        {
          id: inspected.id,
          version: inspected.version,
          bundlePath: source,
          source: null,
          dependencies: inspected.rawDependencies
        }
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
  })

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
}
