import { PROMPT_ENTRIES, entryById, type PromptEntry } from './registry'
// Renderer-facing projection (Plan 2 sends this over IPC). Defined in shared/ so both sides
// import the same declaration — see the docblock there.
import type { PromptEntryView } from '../../../shared/promptsIpc'

export type { PromptEntryView }

export interface PromptStoreDeps {
  /** The dev-tools gate result. Plan 3 uses it to decide whether to read the override file
   *  at all; Plan 1 records it so the wiring and its test exist from the start. */
  devTools: boolean
}

/**
 * The single read path for every hardcoded prompt (spec §2).
 *
 * Plan 1 is resolve-only: `resolve` always returns the registry default. Consumers get their
 * final signature now, so Plan 3 can add the override file without touching a call site.
 */
export class PromptStore {
  constructor(private deps: PromptStoreDeps) {}

  get devTools(): boolean {
    return this.deps.devTools
  }

  entries(): readonly PromptEntry[] {
    return PROMPT_ENTRIES
  }

  resolve(id: string): string {
    const entry = entryById(id)
    // Loud failure on purpose: a typo'd id returning '' would silently blank a persona
    // fragment or a tool description, which is exactly the class of bug this module exists
    // to prevent.
    if (!entry) throw new Error(`unknown prompt id: ${id}`)
    if (entry.category === 'external')
      throw new Error(`prompt "${id}" is external — its text is not in this repo`)
    return entry.default()
  }

  /** Pre-bound resolver for consumers that take a plain `(id) => string`. */
  resolveFn(): (id: string) => string {
    return (id) => this.resolve(id)
  }

  catalog(): PromptEntryView[] {
    return PROMPT_ENTRIES.map((e) => {
      const defaultText = e.default()
      return {
        id: e.id,
        category: e.category,
        title: e.title,
        source: e.source,
        reaches: e.reaches,
        editable: e.editable,
        defaultText,
        overrideText: null,
        chars: defaultText.length,
        ...(e.note ? { note: e.note } : {})
      }
    })
  }
}
