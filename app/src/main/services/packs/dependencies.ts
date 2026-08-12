import semver from 'semver'

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
