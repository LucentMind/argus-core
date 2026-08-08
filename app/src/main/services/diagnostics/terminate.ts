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
 *  identity — see TerminatorDeps.stillIs below — rather than trusting the OS's answer
 *  to "does SOME process hold this pid" after a 5s window in which the OS is free to
 *  recycle it. */
export const KILL_GRACE_MS = 5_000

/** A termination target, carrying enough identity to survive pid reuse across the
 *  grace window. */
export type TerminatorTarget = { pid: number; startTimeMs: number }

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

  const collected: { pid: number; depth: number }[] = []
  const seen = new Set<number>()
  const queue = [row.rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    // A cycle in reported ppids would otherwise spin forever. The sidecar should
    // never emit one, but this walk must not depend on that.
    if (seen.has(pid)) continue
    seen.add(pid)
    const p = byPid.get(pid)
    if (p) collected.push({ pid, depth: p.depth })
    for (const child of childrenOf.get(pid) ?? []) queue.push(child)
  }

  const targets = collected
    .filter(({ pid }) => !denied.has(pid) && byPid.get(pid)?.electronType === undefined)
    .sort((a, b) => b.depth - a.depth)
    .map(({ pid }) => ({ pid, startTimeMs: byPid.get(pid)!.startTimeMs }))

  // Everything in the row was denied or has already exited. Claiming success would
  // leave the page showing "Stopping…" for something nothing was sent to.
  if (targets.length === 0) return { ok: false, reason: 'gone' }
  return { ok: true, targets }
}

export type TerminatorDeps = {
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Re-resolves identity against the CURRENT process tree at escalation time — this is
   *  deliberately NOT "does some process hold this pid" (that's what `process.kill(pid,
   *  0)` answers, and it cannot tell the original target from an unrelated process the
   *  OS recycled the pid to during the grace window). Must return false whenever the
   *  live process at `pid` does not have this exact `startTimeMs`. */
  stillIs: (pid: number, startTimeMs: number) => boolean
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
        if (this.deps.stillIs(t.pid, t.startTimeMs)) this.safeKill(t.pid, 'SIGKILL')
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
