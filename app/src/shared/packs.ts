import type { UpdateStatus } from './updates'

/** Result of peeking at a bundle's manifest without installing (mirrors install.ts). */
export interface InspectResult {
  id: string
  version: string
  platform?: string
  apiCompatible: boolean
  platformCompatible: boolean
  /** Present when the bundle declares a GitHub repo as its update source. Surfaced so an
   *  install-from-repo can refuse a bundle nominating a different update home than the repo it
   *  was just downloaded from. */
  updateRepo?: string
}

/** Outcome of an install attempt (mirrors install.ts). */
export type InstallResult =
  | {
      ok: true
      id: string
      version: string
      previousVersion: string | null
      relaunchRequired: true
    }
  | { ok: false; code: 'manifest' | 'checksum' | 'platform' | 'api' | 'io'; error: string }

export interface PackBinaryHealth {
  id: string
  displayName: string
  ok: boolean
  detail: string
}

/** One row on the Packs settings page. */
export interface InstalledPackRow {
  id: string
  displayName: string
  /** Version recorded in packs-state — the source of truth for "user-installed". null for a bundled/seed pack. */
  installedVersion: string | null
  /** Version currently loaded in the running registry. null until a relaunch loads a fresh install. */
  loadedVersion: string | null
  platform: string | null
  /**
   * This pack's files on disk are not what the running registry loaded, so a relaunch is needed
   * to apply it.
   *
   * Deliberately NOT just `installedVersion != loadedVersion`: that comparison is blind to the
   * two cases the user hits most — reinstalling the SAME version (both sides equal, yet the
   * bytes on disk changed) and uninstalling (installedVersion goes null, yet the pack stays
   * loaded until relaunch). Main records the ids it has actually written since boot and reports
   * them here; the version comparison is kept as a secondary signal.
   */
  pendingRelaunch: boolean
  binaries: PackBinaryHealth[]
  /** Upstream update state for this pack, or null when it has no update source (a seed pack,
   *  or a manifest with no `updateUrl`) or nothing has been checked yet this session. */
  update: UpdateStatus | null
}

export interface PacksListPayload {
  packs: InstalledPackRow[]
  error: string | null
  /**
   * Any pack changed on disk since this process loaded the registry. The Packs page's relaunch
   * banner reads this rather than remembering that it just ran an install: page-local memory dies
   * with the component (navigate away and back, or open a second window, and the prompt is gone
   * while the app is still running stale packs). Reset for free by the relaunch itself, since
   * main is what restarts.
   */
  relaunchRequired: boolean
}

/** One pack a GitHub repository publishes, as offered by the install-from-repo picker. */
export interface RepoPackRow {
  id: string
  version: string
  tag: string
  /** False when this Core cannot run it; `reason` says why. Rendered, never silently dropped. */
  installable: boolean
  reason?: string
}
