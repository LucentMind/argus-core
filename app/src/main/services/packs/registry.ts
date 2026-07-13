import path from 'node:path'
import { loadPacks, type LoadedPack, type PackLoadError } from './loader'
import type { PackBinary, PackDetector, PackWindow } from './manifest'

export class PackRegistry {
  private readonly _packs: LoadedPack[]
  private readonly _errors: PackLoadError[]

  constructor(packs: LoadedPack[], errors: PackLoadError[] = []) {
    this._packs = packs
    this._errors = errors
  }

  static load(packsDirs: string | string[]): PackRegistry {
    const dirs = (Array.isArray(packsDirs) ? packsDirs : [packsDirs]).filter(
      (d, i, all) => all.findIndex((o) => path.resolve(o) === path.resolve(d)) === i
    )
    const merged = new Map<string, LoadedPack>()
    const errors: PackLoadError[] = []
    for (const dir of dirs) {
      const res = loadPacks(dir)
      errors.push(...res.errors)
      for (const p of res.packs) {
        if (merged.has(p.id)) {
          console.warn(`[packs] '${p.id}' in ${dir} shadows an earlier copy — later source wins`)
        }
        merged.set(p.id, p) // later dir wins
      }
    }
    const packs = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
    for (const e of errors) console.warn(`[packs] skipped ${e.dir}: ${e.message}`)
    return new PackRegistry(packs, errors)
  }

  packs(): LoadedPack[] {
    return this._packs
  }

  errors(): PackLoadError[] {
    return this._errors
  }

  personaFragments(): string[] {
    return this._packs
      .map((p) => p.personaText)
      .filter((t): t is string => t != null && t.length > 0)
  }

  skillsSources(): string[] {
    return this._packs.map((p) => p.skillsDir).filter((d): d is string => d != null)
  }

  referencesSources(): string[] {
    return this._packs.map((p) => p.referencesDir).filter((d): d is string => d != null)
  }

  /** All packs' binary declarations, flattened in pack (id-sorted) order. */
  binaryDecls(): Array<{ packDir: string; decl: PackBinary }> {
    return this._packs.flatMap((p) => p.manifest.binaries.map((decl) => ({ packDir: p.dir, decl })))
  }

  /** All packs' window declarations (webPanel + externalApp), flattened in pack (id-sorted) order.
   *  `uiDir` is null for packs that ship no ui/ (externalApp-only packs). */
  windowDecls(): Array<{ packId: string; packDir: string; uiDir: string | null; decl: PackWindow }> {
    return this._packs.flatMap((p) =>
      p.manifest.windows.map((decl) => ({
        packId: p.id,
        packDir: p.dir,
        uiDir: p.uiDir,
        decl
      }))
    )
  }

  /** All packs' detector declarations, flattened in pack order; duplicate types → first wins. */
  detectorDecls(): PackDetector[] {
    const seen = new Set<string>()
    const out: PackDetector[] = []
    for (const p of this._packs) {
      for (const d of p.manifest.detectors) {
        if (seen.has(d.type)) {
          console.warn(`[packs] duplicate detector type '${d.type}' — first declaration wins`)
          continue
        }
        seen.add(d.type)
        out.push(d)
      }
    }
    return out
  }

  /** All packs' reference-routing rules, flattened in pack order. */
  referenceRouting(): Array<{ keywords: string[]; target: string }> {
    return this._packs.flatMap((p) => p.manifest.referenceRouting)
  }
}
