/** Result of peeking at a bundle's manifest without installing (mirrors install.ts). */
export interface InspectResult {
  id: string
  version: string
  platform?: string
  apiCompatible: boolean
  platformCompatible: boolean
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
  /** installedVersion != loadedVersion — a relaunch is needed to apply. */
  pendingRelaunch: boolean
  binaries: PackBinaryHealth[]
}

export interface PacksListPayload {
  packs: InstalledPackRow[]
  error: string | null
}
