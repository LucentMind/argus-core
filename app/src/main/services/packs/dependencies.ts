import semver from 'semver'
import { parseGhRef } from './githubRef'
import type { PackManifest } from './manifest'

/**
 * Why this lives on its own: the same "is this dependency satisfied" rule is asked at three
 * moments that cannot share a caller — install (against packs-state), load (against the on-disk
 * manifests, which is the only source that also covers dev-seeded packs, since those are never
 * recorded in packs-state), and the dependents check that guards replacing a depended-on pack.
 * Three copies of a semver comparison is exactly how the three drift apart, so they share the
 * predicate and keep only their own phrasing.
 */
export type DependencyVerdict = 'ok' | 'missing' | 'invalid-version' | 'out-of-range'

/**
 * Decide one `<range>` against the version actually present, if any.
 *
 * A present-but-unparseable version is `invalid-version`, NOT a pass: `manifest.version` is only
 * constrained to be a non-empty string, so a pack versioned `"nightly"` would otherwise slip
 * through every range it was measured against.
 */
export function checkDependency(installedVersion: string | null, range: string): DependencyVerdict {
  if (installedVersion == null) return 'missing'
  if (!semver.valid(installedVersion)) return 'invalid-version'
  return semver.satisfies(installedVersion, range) ? 'ok' : 'out-of-range'
}

/**
 * A dependency's declared source, before anything is installed.
 *
 * Deliberately NOT `PackSource` (`packsState.ts`): both members of that union require
 * `installedAt`, and a declared source has never been installed, so there is no honest value for
 * it. The executor stamps `installedAt` when it records the pin.
 */
export type DeclaredSource =
  | { kind: 'feed'; updateUrl: string; origin: string }
  | { kind: 'github'; host: string; owner: string; repo: string }

/** One dependency in its canonical shape, whichever manifest form declared it. */
export interface DeclaredDependency {
  id: string
  range: string
  /** null when the entry is a bare range string, or names no source: not auto-installable. */
  source: DeclaredSource | null
}

function declaredSourceOf(entry: {
  updateUrl?: string
  updateRepo?: string
}): DeclaredSource | null {
  if (entry.updateUrl != null) {
    try {
      return {
        kind: 'feed',
        updateUrl: entry.updateUrl,
        origin: new URL(entry.updateUrl).origin
      }
    } catch {
      return null // schema already refused this; belt and braces for hand-built objects
    }
  }
  if (entry.updateRepo != null) {
    const ref = parseGhRef(entry.updateRepo)
    if (ref) return { kind: 'github', host: ref.host, owner: ref.owner, repo: ref.repo }
  }
  return null
}

/**
 * The single reader for `manifest.dependencies`. Every consumer goes through this, so the
 * union form stays confined to the schema: enforcement (`resolveDependencies`,
 * `dependentRangesOn`, `orderPacksByDependencies`) needs only `id` and `range` and never learns
 * that a source exists.
 */
export function normalizeDependencies(
  dependencies: PackManifest['dependencies'] | undefined
): DeclaredDependency[] {
  return Object.entries(dependencies ?? {}).map(([id, entry]) =>
    typeof entry === 'string'
      ? { id, range: entry, source: null }
      : { id, range: entry.range, source: declaredSourceOf(entry) }
  )
}
