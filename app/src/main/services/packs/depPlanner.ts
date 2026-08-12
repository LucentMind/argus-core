import path from 'node:path'
import semver from 'semver'
import { checkDependency, normalizeDependencies, type DeclaredSource } from './dependencies'
import type { CandidateResolver, ResolvedCandidate } from './depSources'
import { describeBrokenDependents } from './install'
import type { PackManifest } from './manifest'
import type { PackSource } from './packsState'
import type { PlannedPack, PlanResult } from '../../../shared/packs'

/** Guards a pathological or hostile manifest chain. Eight is far past any real pack set. */
export const MAX_DEPTH = 8

/** The pack the user asked for, already staged locally. Its bundle is not re-downloaded. */
export interface PlanRoot {
  id: string
  version: string
  bundlePath: string
  source: DeclaredSource | null
  dependencies: PackManifest['dependencies']
}

export interface PlannerDeps {
  resolver: CandidateResolver
  /** Fetch a resolved candidate's bytes to `destPath`, verifying whatever the transport can. */
  download(candidate: ResolvedCandidate, destPath: string): Promise<void>
  /** `inspectBundleSource`; must surface the bundle's own raw `dependencies`. */
  inspect(
    bundlePath: string
  ): Promise<{ id: string; version: string; rawDependencies: PackManifest['dependencies'] }>
  /** `PacksStateStore.list()` — id -> installed version. */
  installed: Record<string, string>
  /**
   * `PacksStateStore.getSource(id)` for every installed id. An already-installed pack is resolved
   * from ITS OWN recorded pin, never from a dependent's declared source: a dependent naming an
   * installed id as a dependency must not be able to redirect where that id's bytes come from.
   * Absent for ids with no recorded update source (e.g. dev-seeded or manually-added packs).
   */
  pins: Record<string, PackSource | undefined>
  argusHome: string
  /** Staging cache. MUST NOT be inside packsDir: downloading is not installing. Created and
   *  removed by the caller (see `planIpc.ts`) — the planner only writes into it. */
  cacheDir: string
}

/** A planned pack plus the bits only the executor needs. */
export interface StagedPack extends PlannedPack {
  bundlePath: string
  source: DeclaredSource | null
}

interface Requirement {
  by: string
  range: string
}

/** A recorded pin, read back as the declared-source shape the resolver takes. The pin carries
 *  `installedAt`; the resolver's input never learns when a source was first pinned. */
function pinToDeclaredSource(pin: PackSource): DeclaredSource {
  return pin.kind === 'github'
    ? { kind: 'github', host: pin.host, owner: pin.owner, repo: pin.repo }
    : { kind: 'feed', updateUrl: pin.updateUrl, origin: pin.origin }
}

/**
 * `'install'` when nothing of this id is installed yet; otherwise `'downgrade'` when the resolved
 * version is genuinely older than what's installed (semver.lt), and `'upgrade'` otherwise —
 * including the two versions being equal (a same-version reinstall), which is closer to an
 * upgrade in spirit ("apply these bytes") than to a downgrade. Not just `semver.lt` reversed:
 * either version failing to parse as semver falls back to 'upgrade' too, matching the previous
 * two-member union's behaviour for non-semver versions rather than silently mislabelling them.
 */
function actionFor(
  resolvedVersion: string,
  installedVersion: string | null
): PlannedPack['action'] {
  if (installedVersion == null) return 'install'
  if (semver.valid(resolvedVersion) && semver.valid(installedVersion)) {
    if (semver.lt(resolvedVersion, installedVersion)) return 'downgrade'
  }
  return 'upgrade'
}

function describeSource(source: DeclaredSource): string {
  return source.kind === 'feed' ? source.origin : `${source.host}/${source.owner}/${source.repo}`
}

/**
 * Strips the staging-only fields (`bundlePath`, `source`) so a plan is safe to send over IPC.
 *
 * Destructure rather than cast: StagedPack is structurally assignable to PlannedPack, so
 * `packs: staged` would compile while leaving bundlePath/source as real own properties. IPC uses
 * structured clone, not a type-directed filter, so a compile-time narrowing would still ship a
 * local filesystem path to the renderer. Build fresh objects instead.
 */
export function toPlannedRows(staged: StagedPack[]): PlannedPack[] {
  return staged.map(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop them
    ({ bundlePath: _bundlePath, source: _source, ...row }) => row
  )
}

export async function buildPlan(deps: PlannerDeps, root: PlanRoot): Promise<PlanResult> {
  const staged = await stagePlan(deps, root)
  if (!staged.ok) return staged
  return { ok: true, packs: toPlannedRows(staged.packs) }
}

/**
 * The planner proper. `buildPlan` narrows the result for IPC; the executor calls this to keep
 * `bundlePath` and `source`, which must never cross the IPC boundary.
 */
export async function stagePlan(
  deps: PlannerDeps,
  root: PlanRoot
): Promise<{ ok: true; packs: StagedPack[] } | Extract<PlanResult, { ok: false }>> {
  const planned = new Map<string, StagedPack>()
  const requirements = new Map<string, Requirement[]>()
  const edges = new Map<string, string[]>() // pack -> ids it depends on, within the plan

  interface Frame {
    id: string
    version: string
    dependencies: PackManifest['dependencies']
    depth: number
    trail: string[]
  }

  const queue: Frame[] = [
    {
      id: root.id,
      version: root.version,
      dependencies: root.dependencies,
      depth: 0,
      trail: [root.id]
    }
  ]
  planned.set(root.id, {
    id: root.id,
    version: root.version,
    action: actionFor(root.version, deps.installed[root.id] ?? null),
    previousVersion: deps.installed[root.id] ?? null,
    originLabel: 'this bundle',
    isRoot: true,
    bundlePath: root.bundlePath,
    source: root.source
  })

  while (queue.length > 0) {
    const frame = queue.shift() as Frame
    if (frame.depth > MAX_DEPTH) {
      return {
        ok: false,
        code: 'cycle',
        error: `dependency chain deeper than ${MAX_DEPTH} packs: ${frame.trail.join(' -> ')}`
      }
    }

    for (const dep of normalizeDependencies(frame.dependencies)) {
      requirements.set(dep.id, [
        ...(requirements.get(dep.id) ?? []),
        { by: frame.id, range: dep.range }
      ])
      edges.set(frame.id, [...(edges.get(frame.id) ?? []), dep.id])

      if (frame.trail.includes(dep.id)) {
        return {
          ok: false,
          code: 'cycle',
          error: `dependency cycle: ${[...frame.trail, dep.id].join(' -> ')}`
        }
      }

      // Already in the plan at a chosen version — the conflict check (Task 4) decides whether
      // that version satisfies this requirement too.
      if (planned.has(dep.id)) continue

      if (checkDependency(deps.installed[dep.id] ?? null, dep.range) === 'ok') continue

      // An already-installed pack is resolved from ITS OWN recorded pin, never from a dependent's
      // declared source: otherwise a hostile pack could name a legitimate installed id as a
      // dependency with a source of its own choosing, and have Core fetch attacker bytes for it.
      const installedPin = deps.installed[dep.id] != null ? deps.pins[dep.id] : undefined
      const resolveFrom: DeclaredSource | null =
        installedPin != null ? pinToDeclaredSource(installedPin) : dep.source

      if (resolveFrom == null) {
        return {
          ok: false,
          code: 'unresolvable',
          error: `pack '${frame.id}' requires '${dep.id}' ${dep.range}, which declares no source to install it from — install it manually`
        }
      }

      let candidate: ResolvedCandidate | null
      try {
        candidate = await deps.resolver.resolve(dep.id, dep.range, resolveFrom)
      } catch (err) {
        return {
          ok: false,
          code: 'unresolvable',
          error: `could not resolve '${dep.id}' ${dep.range}: ${(err as Error).message}`
        }
      }
      if (!candidate) {
        if (installedPin != null) {
          return {
            ok: false,
            code: 'unresolvable',
            error:
              `'${dep.id}' is already installed and pinned to ${describeSource(resolveFrom)}, ` +
              `which publishes nothing satisfying ${dep.range} (required by '${frame.id}'). ` +
              `Refusing to fall back to '${frame.id}''s declared source` +
              (dep.source ? ` (${describeSource(dep.source)})` : '') +
              ` — install '${dep.id}' manually if you want it from there.`
          }
        }
        return {
          ok: false,
          code: 'unresolvable',
          error: `no published version of '${dep.id}' satisfies ${dep.range} for this machine`
        }
      }

      const bundlePath = path.join(deps.cacheDir, `${dep.id}-${candidate.version}.zip`)
      try {
        // `deps.cacheDir` is created by the caller (a fresh `mkdtemp`'d directory per plan; see
        // `planIpc.ts`) before `stagePlan` is ever invoked, and removed by the caller once the plan
        // is applied or refused. The planner only writes into it — creating it per-download here
        // was redundant now that ownership is the caller's, and this survives a plan with zero
        // downloaded dependencies (nothing left to create it).
        await deps.download(candidate, bundlePath)
      } catch (err) {
        return {
          ok: false,
          code: 'unresolvable',
          error: `could not download '${dep.id}' ${candidate.version}: ${(err as Error).message}`
        }
      }

      const inspected = await deps.inspect(bundlePath)
      planned.set(dep.id, {
        id: dep.id,
        version: candidate.version,
        action: actionFor(candidate.version, deps.installed[dep.id] ?? null),
        previousVersion: deps.installed[dep.id] ?? null,
        originLabel: candidate.originLabel,
        isRoot: false,
        bundlePath,
        source: candidate.source
      })
      queue.push({
        id: dep.id,
        version: candidate.version,
        dependencies: inspected.rawDependencies,
        depth: frame.depth + 1,
        trail: [...frame.trail, dep.id]
      })
    }
  }

  const refused = refuse(deps, planned, requirements)
  if (refused) return refused
  return { ok: true, packs: order(planned, edges) }
}

/**
 * The two ways a resolved set can still be incoherent. Both are checked after resolution and
 * before anything is installed, so a refusal writes nothing but the staging cache.
 */
function refuse(
  deps: PlannerDeps,
  planned: Map<string, StagedPack>,
  requirements: Map<string, Requirement[]>
): Extract<PlanResult, { ok: false }> | null {
  // 1. Conflict: the chosen version must satisfy EVERY requirement placed on it, not just the
  //    one that happened to resolve it first.
  for (const [id, reqs] of requirements) {
    const chosenVersion = planned.get(id)?.version ?? deps.installed[id] ?? null
    if (chosenVersion == null) continue
    const unmet = reqs.filter((r) => checkDependency(chosenVersion, r.range) !== 'ok')
    if (unmet.length === 0) continue
    const all = reqs.map((r) => `'${r.by}' requires ${r.range}`).join(', ')
    return {
      ok: false,
      code: 'conflict',
      error: `no single version of '${id}' satisfies every requirement: ${all}; best available is ${chosenVersion}`
    }
  }

  // 2. Breaking an installed dependent OUTSIDE the plan. A dependent that is itself planned is
  //    skipped: its new manifest's ranges are already covered by check 1 above, while the guard
  //    would read its stale on-disk range and refuse a coordinated upgrade the user asked for.
  const alsoInstalling = new Set(planned.keys())
  for (const pack of planned.values()) {
    const breaks = describeBrokenDependents(pack.id, pack.version, deps.argusHome, alsoInstalling)
    if (breaks) return { ok: false, code: 'breaks-dependent', error: breaks }
  }

  return null
}

/** Dependencies before dependents; id sort among unrelated packs, so the plan reads stably. */
function order(planned: Map<string, StagedPack>, edges: Map<string, string[]>): StagedPack[] {
  const out: StagedPack[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    for (const dep of [...(edges.get(id) ?? [])].sort()) {
      if (planned.has(dep)) visit(dep)
    }
    out.push(planned.get(id) as StagedPack)
  }
  for (const id of [...planned.keys()].sort()) visit(id)
  return out
}
