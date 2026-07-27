/**
 * Payload types shared by main (the prompt registry/store) and renderer (the dev page).
 *
 * These live here rather than in `main/services/prompts/` because `tsconfig.web.json` is a
 * separate composite project from `tsconfig.node.json`; a renderer file importing anything
 * under `main/services` trips the composite project's rootDir containment check. Unlike
 * `memoryIpc.ts`, which duplicates shapes whose originals must stay in main, these are pure
 * IPC projections with no main-side dependency — so they were MOVED here, and main imports
 * them back. One definition, no drift.
 */

export type PromptCategory =
  | 'persona'
  | 'session-context'
  | 'tools'
  | 'tool-feedback'
  | 'headless'
  | 'generated-files'
  | 'synthesized'
  | 'external'

/** Section headings on the dev page. Keyed exhaustively so a new category cannot be unlabelled. */
export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  persona: 'Persona & mode identity',
  'session-context': 'Session context blocks',
  tools: 'Tool descriptions',
  'tool-feedback': 'Tool result steering',
  headless: 'Headless contracts',
  'generated-files': 'Generated agent-visible files',
  synthesized: 'Synthesized user messages',
  external: 'External (not in this repo)'
}

/** Renderer-facing projection of one registry entry. */
export interface PromptEntryView {
  id: string
  category: PromptCategory
  title: string
  /** Repo-relative `file:line` of the default, for click-through. */
  source: string
  /** Driver kind slugs that receive this; 'all' = every driver. */
  reaches: readonly string[] | 'all'
  editable: boolean
  defaultText: string
  /** Always null until Plan 3 adds overrides. */
  overrideText: string | null
  /** Length of the effective text (override when present, else default). */
  chars: number
  /** Names of `{name}` tokens the text must keep. Absent for non-template entries. */
  placeholders?: readonly string[]
  /** Present only for `category: 'external'`: where the real text lives. */
  note?: string
}

export interface PromptCatalogPayload {
  entries: PromptEntryView[]
  /** Mode ids the preview tab can render, in MODES order. */
  modes: string[]
  /** Ids with an active override, sorted. Drives the overridden chips and the Settings banner. */
  activeOverrideIds: string[]
  /** Non-null when the override file could not be parsed; the page shows it instead of
   *  pretending no overrides are set. */
  loadError: string | null
}

/** One contiguous span of the composed persona, for boundary marking in the preview. */
export interface PromptPreviewFragment {
  /** Registry id, or null for text the registry does not own (pack fragments, personaAppend). */
  id: string | null
  label: string
  /** Character offsets into `PromptPreview.text`. */
  start: number
  end: number
}

export interface PromptPreview {
  mode: string
  text: string
  fragments: PromptPreviewFragment[]
  /**
   * Blocks a real session appends AFTER the persona that this preview deliberately omits,
   * because they need a live case (agent-access-filtered memory index, resolved skill index).
   * The UI must show this — a preview that silently omits them would misrepresent the prompt.
   */
  omits: string[]
}
