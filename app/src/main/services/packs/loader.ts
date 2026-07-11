import fs from 'node:fs'
import path from 'node:path'
import { PACK_MANIFEST_FILE, packManifestSchema, type PackManifest } from './manifest'

export interface LoadedPack {
  id: string
  dir: string
  manifest: PackManifest
  personaText: string | null
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

      let personaText: string | null = null
      if (manifest.persona) {
        const p = path.join(dir, manifest.persona)
        if (!fs.existsSync(p)) throw new Error(`persona file not found: ${manifest.persona}`)
        personaText = fs.readFileSync(p, 'utf8').trim()
      }

      packs.push({ id: manifest.id, dir, manifest, personaText })
    } catch (err) {
      errors.push({ dir, message: (err as Error).message })
    }
  }

  packs.sort((a, b) => a.id.localeCompare(b.id))
  return { packs, errors }
}
