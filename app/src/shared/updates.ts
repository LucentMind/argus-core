/**
 * One status vocabulary for every updatable thing in Argus — the app itself, and (Increment 2)
 * each installed pack. Defined once so "Checking…", "Update available" and failure wording
 * cannot drift between the two surfaces the way status wording has drifted here before.
 *
 * Must not import from `src/main`: `tsconfig.web.json` excludes it, and a shared→main import
 * breaks `typecheck:web`.
 */
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

export type UpdateStatus =
  | { phase: 'idle' }
  /** Structurally impossible here — an unpackaged build. Not an error; never shown as one. */
  | { phase: 'unsupported'; reason: string }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; percent: number }
  /** Bytes are staged; a restart applies them. */
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string; at: number; code?: UpdateErrorCode }

/** Everything the app-update surface renders. */
export interface CoreUpdatePayload {
  currentVersion: string
  status: UpdateStatus
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
      return `Version ${status.version} is available`
    case 'downloading':
      return `Downloading… ${status.percent}%`
    case 'ready':
      return `Version ${status.version} is ready — restart to apply`
    case 'error':
      return `Update failed: ${status.message}`
  }
}
