import path from 'node:path'
import { JsonFileStore } from '../fileStore'
import { PROMPT_ENTRIES, entryById, type PromptEntry } from './registry'
import type { PromptCatalogPayload, PromptEntryView } from '../../../shared/promptsIpc'

export type { PromptEntryView }

export interface PromptStoreDeps {
  /** The dev-tools gate result. Load-bearing: see the constructor. */
  devTools: boolean
  /**
   * Root holding `config/dev-prompt-overrides.json`. OPTIONAL — omitting it means no override
   * file is ever constructed, the same inert behavior as the gate being off. Tests that only
   * exercise defaults omit it; production always passes it.
   */
  argusHome?: string
}

/** Where the override file lives, relative to ARGUS_HOME. Deliberately NOT settings.json:
 *  keeping it separate leaves the settings schema, stripDefaults and SETTINGS_ATOMIC_PATHS
 *  untouched, and keeps dev-only state out of the object validated on every user change. */
const OVERRIDE_REL = ['config', 'dev-prompt-overrides.json']

/**
 * The single read path for every hardcoded prompt (spec §2).
 *
 * `resolve(id)` is `override ?? default()`. Overrides are read from a gated file; consumers
 * are unchanged from Plan 1, which is the whole point of having routed them through `resolve`.
 */
export class PromptStore {
  private file: JsonFileStore | null = null
  private overrides: Record<string, string> = {}
  private loadErr: string | null = null

  constructor(private deps: PromptStoreDeps) {
    // GUARD 1. With the gate off the file store is never constructed, so there is no code path
    // that reads an override file — one that ships by accident is inert, not a silent behavior
    // change. Constructing it and then choosing not to apply it would be one `if` away from a
    // production bug; not constructing it cannot be.
    if (deps.devTools && deps.argusHome) {
      this.file = new JsonFileStore(path.join(deps.argusHome, ...OVERRIDE_REL))
      this.reload()
    }
  }

  get devTools(): boolean {
    return this.deps.devTools
  }

  /** Non-null when the override file exists but could not be parsed. */
  get loadError(): string | null {
    return this.loadErr
  }

  private reload(): void {
    if (!this.file) return
    const { data, error } = this.file.load()
    this.loadErr = error
    const next: Record<string, string> = {}
    for (const [id, text] of Object.entries((data ?? {}) as Record<string, unknown>)) {
      // Non-strings are ignored rather than coerced: `String(42)` would quietly become a prompt.
      if (typeof text !== 'string') continue
      const entry = entryById(id)
      // A stale id (renamed entry) or a now-read-only one is dropped. Keeping it would leave a
      // permanent phantom in the banner for text nothing resolves.
      if (!entry || !entry.editable) continue
      next[id] = text
    }
    this.overrides = next
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
    return this.overrides[id] ?? entry.default()
  }

  /** Pre-bound resolver for consumers that take a plain `(id) => string`. */
  resolveFn(): (id: string) => string {
    return (id) => this.resolve(id)
  }

  /** Sorted so the banner and the boot log read the same order every time. */
  activeOverrideIds(): string[] {
    return Object.keys(this.overrides).sort()
  }

  catalog(): PromptEntryView[] {
    return PROMPT_ENTRIES.map((e) => {
      const defaultText = e.default()
      const overrideText = this.overrides[e.id] ?? null
      return {
        id: e.id,
        category: e.category,
        title: e.title,
        source: e.source,
        reaches: e.reaches,
        editable: e.editable,
        defaultText,
        overrideText,
        // The effective text — what the model actually receives.
        chars: (overrideText ?? defaultText).length,
        ...(e.note ? { note: e.note } : {})
      }
    })
  }

  /** The full renderer payload. One call so the page can never render entries and override
   *  state from two different reads. */
  catalogPayload(modes: string[] = []): PromptCatalogPayload {
    return {
      entries: this.catalog(),
      modes,
      activeOverrideIds: this.activeOverrideIds(),
      loadError: this.loadErr
    }
  }

  /** The write-side half of guard 1: with the gate off there is no file object to write to.
   *  Extracted so the condition and its message have exactly one definition. */
  private assertGateOpen(): void {
    if (!this.deps.devTools || !this.file)
      throw new Error('dev tools are not enabled (set ARGUS_DEV_TOOLS=1)')
  }

  /** Shared refusal for every write path. */
  private assertWritable(id: string): void {
    this.assertGateOpen()
    const entry = entryById(id)
    if (!entry) throw new Error(`unknown prompt id: ${id}`)
    // external (and any future pack-owned) text is displayed because it reaches the model, but
    // its bytes are not ours to invent.
    if (!entry.editable) throw new Error(`prompt "${id}" is read-only`)
  }

  /** An empty string is a real override — "what happens with no citation rules?" is a question
   *  this instrument exists to answer. Use `clearOverride` to go back to the default. */
  setOverride(id: string, text: string): void {
    this.assertWritable(id)
    this.overrides = { ...this.overrides, [id]: text }
    this.persist()
  }

  clearOverride(id: string): void {
    this.assertWritable(id)
    // Deliberately not an error when absent: "clear all" and a double-click on Reset both land
    // here, and turning a harmless repeat into a dialog helps no one.
    const rest = { ...this.overrides }
    delete rest[id]
    this.overrides = rest
    this.persist()
  }

  clearAll(): void {
    this.assertGateOpen()
    this.overrides = {}
    this.persist()
  }

  private persist(): void {
    // JsonFileStore.write is temp + rename, so a crash cannot leave a half-written file that
    // would load as "no overrides" and silently discard the edit.
    this.file!.write(this.overrides)
    // The on-disk state is now known-good, so a stale parse error from boot no longer describes
    // reality.
    this.loadErr = null
  }
}
