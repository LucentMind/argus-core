import fs from 'node:fs'
import path from 'node:path'
import { PACK_MANIFEST_FILE, packManifestSchema, type PackManifest } from './manifest'
import { isApiCompatible } from './compat'

function subdirIfExists(dir: string, name: string): string | null {
  const p = path.join(dir, name)
  try {
    return fs.statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

export interface LoadedPack {
  id: string
  dir: string
  manifest: PackManifest
  personaText: string | null
  /** Absolute path of <pack>/skills, when the pack ships skills. */
  skillsDir: string | null
  /** Absolute path of <pack>/references, when the pack ships references. */
  referencesDir: string | null
}

export interface PackLoadError {
  dir: string
  message: string
}

export function loadPacks(packsDir: string): { packs: LoadedPack[]; errors: PackLoadError[] } {
  const packs: LoadedPack[] = []
  const errors: PackLoadError[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(packsDir, { withFileTypes: true })
  } catch {
    return { packs, errors }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(packsDir, ent.name)
    const manifestPath = path.join(dir, PACK_MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) continue // not a pack — ignore

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const manifest = packManifestSchema.parse(raw)

      if (manifest.id !== ent.name) {
        throw new Error(`pack id '${manifest.id}' must match its directory name '${ent.name}'`)
      }

      if (!isApiCompatible(manifest.argusApi)) {
        throw new Error(
          `pack '${manifest.id}' requires argusApi '${manifest.argusApi}', incompatible with Core pack API`
        )
      }

      let personaText: string | null = null
      if (manifest.persona) {
        const p = path.join(dir, manifest.persona)
        if (!fs.existsSync(p)) throw new Error(`persona file not found: ${manifest.persona}`)
        personaText = fs.readFileSync(p, 'utf8').trim()
      }

      packs.push({
        id: manifest.id,
        dir,
        manifest,
        personaText,
        skillsDir: subdirIfExists(dir, 'skills'),
        referencesDir: subdirIfExists(dir, 'references')
      })
    } catch (err) {
      errors.push({ dir, message: (err as Error).message })
    }
  }

  packs.sort((a, b) => a.id.localeCompare(b.id))
  return { packs, errors }
}
