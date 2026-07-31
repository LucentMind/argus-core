let cached: Promise<string | null> | null = null

/**
 * The signed-in GitHub login, or null when gh is missing, unauthenticated, or unreachable.
 *
 * Memoised for the life of the renderer: `sourceControl.status()` spawns `gh --version` and
 * `gh auth status`, and the home dashboard remounts on every return from a case. The login does
 * not change mid-session in any normal use; a `gh auth switch` behind the app's back leaves a
 * stale name until reload, which is the trade we chose over re-spawning on every mount.
 *
 * Never rejects — the caller renders a bare greeting instead. The optional chaining is
 * load-bearing, not defensive noise: renderer suites mock only the bridges they exercise, so
 * `sourceControl` is genuinely absent in most of them.
 */
export function githubLogin(): Promise<string | null> {
  cached ??= (async () => {
    try {
      const status = await window.argus?.sourceControl?.status()
      return status?.login ?? null
    } catch {
      return null
    }
  })()
  return cached
}

/** Test seam — drops the memoised promise so each case starts from a cold cache. */
export function resetGithubIdentity(): void {
  cached = null
}
