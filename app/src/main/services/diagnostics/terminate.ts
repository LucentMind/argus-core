import type { DiagnosticsSnapshot } from '../../../shared/diagnostics'

/**
 * Termination targets and escalation. Electron-free and clock-free by injection,
 * like model.ts and history.ts, so the whole thing tests without a real process.
 */

/** How long a target has to exit on its own before SIGKILL. Numerically matches
 *  ExternalAppHost's KILL_GRACE_MS, but the two paths are NOT the same design: that
 *  escalation guards on `this.apps.get(key)?.status === 'running'` (cleared by the
 *  child's own exit event) and signals through a ProcessHandle, so it is never fooled
 *  by pid reuse. This path re-signals a bare pid, so it must independently re-resolve
 *  identity — see TerminatorDeps.treeStartTimeMs below — rather than trusting the OS's
 *  answer to "does SOME process hold this pid" after a 5s window in which the OS is
 *  free to recycle it. */
export const KILL_GRACE_MS = 5_000

/** A termination target, carrying enough identity to survive pid reuse across the
 *  grace window, PLUS the pid of its immediate parent at resolve time. `parentPid` is
 *  not identity — it is a structural canary: the sidecar's tree walk (tree.rs) only
 *  enqueues a pid as a child of an already-tracked, currently-alive parent, so a
 *  target vanishes from the tree both when it exits for real AND when an ancestor
 *  dies first (see Terminator.shouldKill below for why that second case cannot be
 *  read as death). */
export type TerminatorTarget = { pid: number; startTimeMs: number; parentPid: number }

export type ResolvedTargets =
  { ok: true; targets: TerminatorTarget[] } | { ok: false; reason: 'gone' | 'not-terminable' }

/**
 * Resolve a row id to the pids that must die, ordered DEEPEST FIRST.
 *
 * Leaves-first is load-bearing, not cosmetic. The whole scan is a BFS from the
 * Electron main pid, so a surviving child whose ppid points at a dead parent is
 * unreachable from the root and vanishes from the page entirely while still
 * consuming CPU. Killing the deepest process first cannot manufacture one.
 *
 * The walk deliberately DESCENDS THROUGH NESTED ROWS: a labeled descendant starts
 * its own row (see model.ts), so an MCP server under a driver is excluded from the
 * driver's processCount but is still that driver's child. Stopping at the row
 * boundary would strand it behind exactly the invisibility described above. This
 * is why the returned pid count can exceed the row's `processCount`, and why the
 * confirm copy never quotes a number.
 *
 * `denied` is re-checked here rather than trusted from the row: this is the second
 * of two independent gates that stop the page from killing its own app.
 */
export function resolveTargets(
  snapshot: DiagnosticsSnapshot,
  id: string,
  denied: ReadonlySet<number>
): ResolvedTargets {
  const row = snapshot.objects.find((o) => o.id === id)
  if (!row || row.rootPid === null) return { ok: false, reason: 'gone' }
  if (!row.terminable) return { ok: false, reason: 'not-terminable' }

  const childrenOf = new Map<number, number[]>()
  const byPid = new Map<number, (typeof snapshot.tree)[number]>()
  for (const p of snapshot.tree) {
    byPid.set(p.pid, p)
    if (p.pid === p.ppid) continue
    const list = childrenOf.get(p.ppid)
    if (list) list.push(p.pid)
    else childrenOf.set(p.ppid, [p.pid])
  }
  if (!byPid.has(row.rootPid)) return { ok: false, reason: 'gone' }

  const collected: { pid: number; depth: number; ppid: number }[] = []
  const seen = new Set<number>()
  const queue = [row.rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    // A cycle in reported ppids would otherwise spin forever. The sidecar should
    // never emit one, but this walk must not depend on that.
    if (seen.has(pid)) continue
    seen.add(pid)
    const p = byPid.get(pid)
    if (p) collected.push({ pid, depth: p.depth, ppid: p.ppid })
    for (const child of childrenOf.get(pid) ?? []) queue.push(child)
  }

  const targets = collected
    .filter(({ pid }) => !denied.has(pid) && byPid.get(pid)?.electronType === undefined)
    .sort((a, b) => b.depth - a.depth)
    .map(({ pid, ppid }) => ({ pid, startTimeMs: byPid.get(pid)!.startTimeMs, parentPid: ppid }))

  // Everything in the row was denied or has already exited. Claiming success would
  // leave the page showing "Stopping…" for something nothing was sent to.
  if (targets.length === 0) return { ok: false, reason: 'gone' }
  return { ok: true, targets }
}

export type TerminatorDeps = {
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Looks up the CURRENT process tree at escalation time and returns the live
   *  startTimeMs reported for `pid`, or null if the tree has no row for it at all.
   *  Deliberately NOT "does some process hold this pid" (that's what `process.kill(pid,
   *  0)` answers, and it cannot tell the original target from an unrelated process the
   *  OS recycled the pid to during the grace window) — a non-null return that does not
   *  equal the target's original startTimeMs means exactly that: recycled, not ours,
   *  never escalate. A null return means the tree has no opinion on `pid` at all, which
   *  Terminator.shouldKill below must NOT read as "exited" on its own — see isAlive. */
  treeStartTimeMs: (pid: number) => number | null
  /** Raw OS liveness (`process.kill(pid, 0)`) — the escape hatch for exactly the case
   *  `treeStartTimeMs` cannot answer: this target's row is gone from the tree AND the
   *  row for its own parent (`TerminatorTarget.parentPid`) is ALSO gone. The sidecar's
   *  tree walk (tree.rs) only reaches a pid through an unbroken chain of currently-alive
   *  ancestors, so losing the parent's row is enough to make the whole subtree below it
   *  unreachable regardless of whether those descendants are themselves alive or dead —
   *  see the module docblock on resolveTargets. This predicate is never consulted when
   *  the parent's row is still present, so it can never resurrect the recycled-pid
   *  hazard `treeStartTimeMs` exists to close. */
  isAlive: (pid: number) => boolean
}

/**
 * SIGTERM now, SIGKILL to whatever is still alive after the grace window.
 *
 * PLATFORM NOTE: on Windows `process.kill(pid, 'SIGTERM')` maps to TerminateProcess
 * and is already fatal, so the escalation can only ever fire on macOS. There is no
 * graceful signal to send on Windows — this is not a gap to close, and the confirm
 * copy must not promise a clean shutdown.
 */
export class Terminator {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: TerminatorDeps) {}

  signal(targets: readonly TerminatorTarget[]): void {
    for (const t of targets) this.safeKill(t.pid, 'SIGTERM')
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      for (const t of targets) {
        if (this.shouldKill(t)) this.safeKill(t.pid, 'SIGKILL')
      }
    }, KILL_GRACE_MS)
    // Never hold the process open for an escalation nobody is waiting on.
    timer.unref?.()
    this.timers.add(timer)
  }

  /** Drop pending escalations — called from DiagnosticsService.stop(). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * Whether `t` should be SIGKILLed after the grace window.
   *
   * `signal()` above SIGTERMs an entire subtree in one synchronous loop, so a shallow
   * target exiting before a deeper, wedged one is the NORMAL outcome, not an exotic
   * race — that wedged leaf is exactly why the user pressed Stop. The sidecar's tree
   * walk (tree.rs) reaches a pid only through an unbroken chain of currently-alive
   * ancestors, so that ordinary shallow-exits-first sequence makes the deeper target
   * disappear from the tree too, even though it is very much still running. Treating
   * "absent from the tree" as "dead" — the bug this method exists to fix — would
   * silently drop the SIGKILL on precisely the wedged process the escalation exists to
   * catch, leaving it alive, invisible, and with no row left to ever Stop again.
   *
   * So absence is only trusted as death when the tree could actually have seen this
   * pid: when its immediate parent (`t.parentPid`) is still present. If the parent's
   * row is ALSO gone, the walk is structurally blind here — the tree cannot answer
   * either way — and only then does this fall back to a raw OS liveness check.
   */
  private shouldKill(t: TerminatorTarget): boolean {
    const current = this.deps.treeStartTimeMs(t.pid)
    if (current !== null) return current === t.startTimeMs
    const ancestorPresent = this.deps.treeStartTimeMs(t.parentPid) !== null
    if (ancestorPresent) return false
    return this.deps.isAlive(t.pid)
  }

  /** A pid that exited between resolution and signalling throws ESRCH. That is the
   *  expected outcome of a race, not a failure, and it must not skip the rest. */
  private safeKill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.deps.kill(pid, signal)
    } catch (err) {
      console.error(`[diagnostics] ${signal} to pid ${pid} failed`, err)
    }
  }
}
