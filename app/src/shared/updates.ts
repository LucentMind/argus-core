/**
 * One status vocabulary for every updatable thing in Argus — the app itself, and (Increment 2)
 * each installed pack. Defined once so "Checking…", "Update available" and failure wording
 * cannot drift between the two surfaces the way status wording has drifted here before.
 *
 * Must not import from `src/main`: `tsconfig.web.json` excludes it, and a shared→main import
 * breaks `typecheck:web`.
 */
/**
 * The release track an install follows.
 *
 * `beta` maps to electron-updater's `allowPrerelease`, and the identifier in the tag itself
 * must literally be `beta` (or `alpha`). `GitHubProvider.getLatestVersion` derives the running
 * channel from the running version's prerelease component and only accepts a *stable* release
 * for a channel it recognises — with a custom identifier like `nightly`, an install would be
 * offered nightlies forever and never graduate to a stable release.
 */
export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

/**
 * Machine-readable failure kinds, for the few cases where the UI must branch rather than just
 * print a sentence — a pinned-origin refusal offers "download it manually" instead of a retry.
 * Optional: Core's updater sets no code, and `describeUpdate` never reads it.
 */
export type UpdateErrorCode =
  | 'feed'
  | 'download'
  | 'redirect'
  | 'insecure'
  | 'origin-pin'
  | 'too-large'
  | 'checksum'
  | 'install'
  /** The GitHub CLI (gh) is not installed or not on PATH. Distinct from 'gh-auth': installing
   *  gh and signing in are two different fixes, and the Packs row must not conflate them. */
  | 'gh-missing'
  /** `gh` ran but is not authenticated. Distinct from 'feed' because the fix is the user's, and
   *  the Packs row must say so. */
  | 'gh-auth'
  /** `gh` answered HTTP 404 for the pinned repo — not found, or private and not visible to this
   *  account. GitHub answers identically for the two, so this code must not pretend to know
   *  which. */
  | 'gh-notfound'
  /** `gh` answered HTTP 403 — either the org requires SAML/SSO authorization for this token, or
   *  the account is rate-limited. GitHub does not reliably distinguish the two in a form worth
   *  parsing, so this code must not pretend to know which. */
  | 'gh-forbidden'
  /** Any other `gh` failure (a malformed response, a mid-call network blip) — rate-limiting is
   *  'gh-forbidden' above, not this. Not attributable to a specific fix, so it is treated the same
   *  as 'feed'/'download': transport noise that never becomes a `BlockedReason`, and is silently
   *  re-offered next survey. */
  | 'gh-failed'

export type UpdateStatus =
  | { phase: 'idle' }
  /** Structurally impossible here — an unpackaged build. Not an error; never shown as one. */
  | { phase: 'unsupported'; reason: string }
  | { phase: 'checking' }
  /** `downgrade` marks an offer whose version is LOWER than the running one — the shape a
   *  return to stable takes for someone running a prerelease. Core-only; packs never set it. */
  | { phase: 'available'; version: string; notes?: string; downgrade?: true }
  | { phase: 'downloading'; percent: number }
  /** Bytes are staged; a restart applies them. */
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string; at: number; code?: UpdateErrorCode }

/** Everything the app-update surface renders. */
export interface CoreUpdatePayload {
  currentVersion: string
  status: UpdateStatus
  /** The channel actually in effect — not necessarily the persisted setting, since a switch is
   *  refused while a download is staged (`CoreUpdaterService.setChannel`). The UI renders this
   *  and never the setting, so it cannot show a channel the app is not on. */
  channel: UpdateChannel
}

/**
 * The one place every phase's status sentence is worded — this is what "Checking…", "Update
 * available" and failure wording being "defined once" actually means. Covers all 7 phases.
 *
 * `error` is produced by both `check()` and `download()` (see `CoreUpdaterService`), so its
 * wording must not claim the failure came from a check — "Update failed", not "Check failed".
 *
 * Used verbatim as the Settings row's status line. The banner is an interrupting notice with a
 * different phrasing role (it names the app as the sentence subject; Settings already has a
 * "Version" label to its left) and only ever renders the `available`/`ready` phases, so it keeps
 * its own short headline for those two — but never for `error` or `checking`, which it doesn't
 * render at all, so there is nothing for it to word inconsistently with this function.
 *
 * `subject` distinguishes the one phase whose wording actually names the thing being described:
 * `idle` for the Core app is "Argus is up to date"; the same phase for a pack must not claim to
 * speak for the whole app. Every other phase's sentence is already subject-neutral, so only
 * `idle` branches. Defaults to `'core'` so every existing call site (and the Core banner's
 * wording, which has its own passing tests) is unaffected.
 */
export function describeUpdate(status: UpdateStatus, subject: 'core' | 'pack' = 'core'): string {
  switch (status.phase) {
    case 'idle':
      return subject === 'pack' ? 'No update available' : 'Argus is up to date'
    case 'unsupported':
      return status.reason
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return status.downgrade
        ? `Version ${status.version} is the current stable release — installing it moves this install back`
        : `Version ${status.version} is available`
    case 'downloading':
      return `Downloading… ${status.percent}%`
    case 'ready':
      return `Version ${status.version} is ready — restart to apply`
    case 'error':
      return `Update failed: ${status.message}`
  }
}
