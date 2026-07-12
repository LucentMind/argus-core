import fs from 'node:fs'
import path from 'node:path'

export function packsDir(argusHome: string): string {
  return process.env.ARGUS_PACKS_DIR ?? path.join(argusHome, 'packs')
}

/**
 * The read-only, Core-shipped internal-packs dir (e.g. code-graph). Loaded in place,
 * never written. Packaged: <resources>/packs.seed (electron-builder extraResources).
 * Dev: repo-root packs/ next to app/. Overridable via ARGUS_PACKS_SRC.
 */
export function seededPacksDir(appRoot: string, resourcesPath?: string): string {
  if (process.env.ARGUS_PACKS_SRC) return process.env.ARGUS_PACKS_SRC
  if (resourcesPath) {
    const seeded = path.join(resourcesPath, 'packs.seed')
    if (fs.existsSync(seeded)) return seeded
  }
  return path.resolve(appRoot, '..', 'packs')
}

/** Ensure the writable install dir (ARGUS_HOME/packs) exists; returns it. Never clobbers. */
export function ensurePacksDir(argusHome: string): string {
  const dir = packsDir(argusHome)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
