import { loadPacks, type LoadedPack, type PackLoadError } from './loader'

export class PackRegistry {
  private readonly _packs: LoadedPack[]
  private readonly _errors: PackLoadError[]

  constructor(packs: LoadedPack[], errors: PackLoadError[] = []) {
    this._packs = packs
    this._errors = errors
  }

  static load(packsDir: string): PackRegistry {
    const { packs, errors } = loadPacks(packsDir)
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
}
