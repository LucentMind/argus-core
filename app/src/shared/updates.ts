/**
 * One status vocabulary for every updatable thing in Argus — the app itself, and (Increment 2)
 * each installed pack. Defined once so "Checking…", "Update available" and failure wording
 * cannot drift between the two surfaces the way status wording has drifted here before.
 *
 * Must not import from `src/main`: `tsconfig.web.json` excludes it, and a shared→main import
 * breaks `typecheck:web`.
 */
export type UpdateStatus =
  | { phase: 'idle' }
  /** Structurally impossible here — an unpackaged build. Not an error; never shown as one. */
  | { phase: 'unsupported'; reason: string }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; percent: number }
  /** Bytes are staged; a restart applies them. */
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string; at: number }

/** Everything the app-update surface renders. */
export interface CoreUpdatePayload {
  currentVersion: string
  status: UpdateStatus
}
