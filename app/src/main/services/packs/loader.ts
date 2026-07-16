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

/** A window's entry must be a contained forward-slash relative path (no absolute, no backslash, no '..'). */
function entryUnderUi(uiDir: string, entry: string): string | null {
  if (
    path.isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    return null
  }
  return path.join(uiDir, ...entry.split('/'))
}

/** An externalApp entry must be a contained forward-slash relative path under the pack dir. */
function entryUnderDir(dir: string, entry: string): string | null {
  if (
    path.isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    return null
  }
  return path.join(dir, ...entry.split('/'))
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
  /** Absolute path of <pack>/ui, when the pack ships web panels. */
  uiDir: string | null
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
    if (ent.name.startsWith('.') || ent.name.endsWith('.bak')) continue // backup / hidden dir — not a pack
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

      const uiDir = subdirIfExists(dir, 'ui')
      const webPanels = manifest.windows.filter((w) => w.kind === 'webPanel')
      if (webPanels.length > 0 && !uiDir) {
        throw new Error(`pack '${manifest.id}' declares webPanel windows but has no ui/ dir`)
      }
      for (const w of manifest.windows) {
        if (w.kind === 'webPanel') {
          const entryPath = entryUnderUi(uiDir as string, w.entry)
          if (!entryPath || !fs.existsSync(entryPath)) {
            throw new Error(`window '${w.id}' entry not found under ui/: ${w.entry}`)
          }
        } else {
          if (w.control?.channel !== 'stdio') {
            throw new Error(`externalApp window '${w.id}' requires control.channel 'stdio'`)
          }
          const entryPath = entryUnderDir(dir, w.entry)
          if (!entryPath || !fs.existsSync(entryPath)) {
            throw new Error(`externalApp window '${w.id}' entry not found: ${w.entry}`)
          }
        }
      }

      packs.push({
        id: manifest.id,
        dir,
        manifest,
        personaText,
        skillsDir: subdirIfExists(dir, 'skills'),
        referencesDir: subdirIfExists(dir, 'references'),
        uiDir
      })
    } catch (err) {
      errors.push({ dir, message: (err as Error).message })
    }
  }

  packs.sort((a, b) => a.id.localeCompare(b.id))
  return { packs, errors }
}
