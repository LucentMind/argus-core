import type { BinariesService } from './binaries'
import type { PackRegistry } from './registry'

export interface ResolvedExtract {
  command: string
  args: string[] // still contain '{input}' / '{output}' placeholders
}

export interface Extractors {
  extractFor(type: string): ResolvedExtract | null
}

/**
 * Resolve each detector's extract command through the binary registry.
 * exe → the resolved binary path (null when unresolved — extraction is skipped, not fatal);
 * pathDir → the bare executable name (BinariesService already prepended the dir to PATH).
 */
export function createExtractors(registry: PackRegistry, binaries: BinariesService): Extractors {
  const warned = new Set<string>()
  const byType = new Map(registry.detectorDecls().map((d) => [d.type, d]))
  return {
    extractFor(type: string): ResolvedExtract | null {
      const decl = byType.get(type)
      if (!decl?.extract) return null
      const bin = binaries.get(decl.extract.bin)
      if (!bin) {
        if (!warned.has(type)) {
          warned.add(type)
          console.warn(`[packs] detector '${type}': extract.bin '${decl.extract.bin}' is not a declared binary`)
        }
        return null
      }
      if (bin.decl.kind === 'pathDir') {
        return { command: bin.decl.names[0], args: [...decl.extract.args] }
      }
      if (!bin.value) {
        if (!warned.has(type)) {
          warned.add(type)
          console.warn(`[packs] detector '${type}': binary '${decl.extract.bin}' unresolved — extraction disabled`)
        }
        return null
      }
      return { command: bin.value, args: [...decl.extract.args] }
    }
  }
}
