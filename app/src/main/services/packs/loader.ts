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

/** packId -> the ids it declares for one namespace, deduped (an intra-pack repeat is not a collision). */
function declaredIds(packs: LoadedPack[], of: (p: LoadedPack) => string[]): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  for (const p of packs) {
    for (const id of new Set(of(p))) owners.set(id, [...(owners.get(id) ?? []), p.id])
  }
  return owners
}

/**
 * Orders packs so every pack follows the packs it declares in `dependencies` (id sort as
 * tiebreaker), and turns the three ways a pack set can be incoherent into per-pack load errors:
 * a binary id / detector type declared by two packs, a declared dependency that is not installed
 * (or itself failed), and a dependency cycle. A failing pack is excluded so nothing it declares
 * silently shadows another pack's.
 */
export function orderPacksByDependencies(input: LoadedPack[]): {
  packs: LoadedPack[]
  errors: PackLoadError[]
} {
  const byId = new Map(input.map((p) => [p.id, p]))
  const errors: PackLoadError[] = []
  const failed = new Set<string>()

  for (const [kind, owners] of [
    ['binary id', declaredIds(input, (p) => p.manifest.binaries.map((b) => b.id))],
    ['detector type', declaredIds(input, (p) => p.manifest.detectors.map((d) => d.type))]
  ] as const) {
    for (const [id, packIds] of owners) {
      if (packIds.length < 2) continue
      for (const packId of packIds) {
        failed.add(packId)
        errors.push({
          dir: byId.get(packId)!.dir,
          message: `duplicate ${kind} '${id}' declared by packs ${[...packIds].sort().join(', ')} - ids must be unique across installed packs`
        })
      }
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const p of input) {
      if (failed.has(p.id)) continue
      for (const [depId, range] of Object.entries(p.manifest.dependencies)) {
        if (byId.has(depId) && !failed.has(depId)) continue
        failed.add(p.id)
        changed = true
        errors.push({
          dir: p.dir,
          message: byId.has(depId)
            ? `pack '${p.id}' requires pack '${depId}' ${range}, which failed to load`
            : `pack '${p.id}' requires pack '${depId}' ${range}, which is not installed`
        })
        break
      }
    }
  }

  const remaining = input.filter((p) => !failed.has(p.id))
  const indegree = new Map(
    remaining.map((p) => [p.id, Object.keys(p.manifest.dependencies).length])
  )
  const dependents = new Map<string, string[]>()
  for (const p of remaining) {
    for (const depId of Object.keys(p.manifest.dependencies)) {
      dependents.set(depId, [...(dependents.get(depId) ?? []), p.id])
    }
  }

  const ready = remaining.filter((p) => indegree.get(p.id) === 0).map((p) => p.id)
  const ordered: LoadedPack[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => a.localeCompare(b))
    const id = ready.shift() as string
    ordered.push(byId.get(id) as LoadedPack)
    for (const dependent of dependents.get(id) ?? []) {
      const left = (indegree.get(dependent) as number) - 1
      indegree.set(dependent, left)
      if (left === 0) ready.push(dependent)
    }
  }

  if (ordered.length < remaining.length) {
    const placed = new Set(ordered.map((p) => p.id))
    const stuck = remaining.filter((p) => !placed.has(p.id)).map((p) => p.id)
    for (const id of stuck) {
      errors.push({
        dir: (byId.get(id) as LoadedPack).dir,
        message: `pack '${id}' cannot be ordered: dependency cycle among ${[...stuck].sort().join(', ')}`
      })
    }
  }

  return { packs: ordered, errors }
}
