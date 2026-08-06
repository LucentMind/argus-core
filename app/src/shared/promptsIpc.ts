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

import type { SystemPromptTransport } from './drivers'

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

/** One span of the composed persona, as it was at session-construction time. */
export interface PromptCaptureFragment {
  /** Registry id, or null for text the registry does not own (pack fragments, personaAppend). */
  id: string | null
  label: string
  chars: number
  /** True when an active override supplied this fragment's text. */
  overridden: boolean
}

export interface PromptCaptureTool {
  name: string
  description: string
  origin: 'native' | 'pack' | 'connector'
}

/**
 * What one session was actually built with — the only artifact that can reveal per-driver
 * divergence, because the static catalog describes what the harness composes, not what a driver
 * forwarded.
 *
 * There is deliberately no separate `droppedText`: when `transport` is `'none'` the text the
 * driver discarded IS `systemAppend`. Two fields that must always agree eventually do not.
 */
export interface SessionPromptCapture {
  caseSlug: string
  sessionId: number
  createdAt: string
  driverKind: string
  model: string | null
  mode: string
  permissionMode: string
  /** Which wire field carried `systemAppend`. `'none'` means it was built and thrown away. */
  transport: SystemPromptTransport
  systemAppend: string
  fragments: PromptCaptureFragment[]
  skillIndex: string
  referenceIndex: string
  memoryIndex: string
  enabledSkills: string[]
  tools: PromptCaptureTool[]
  /** GUARD 4: the override ids live at construction time, so a transcript investigated later
   *  carries the evidence that the agent was not running on built-in prompts. */
  activeOverrides: string[]
}

/** Row shape for the capture list; the full record is fetched only when one is opened. */
export interface PromptCaptureSummary {
  caseSlug: string
  sessionId: number
  createdAt: string
  driverKind: string
  mode: string
  transport: SystemPromptTransport
  /** Length of the captured `systemAppend`. */
  chars: number
  overrideCount: number
}

export interface PromptCaptureDetail {
  capture: SessionPromptCapture
  /** Whether the captured `systemAppend` still begins with the persona a NEW session in this
   *  capture's mode would build right now (computed server-side, not shipped: the Composed
   *  preview tab already shows that exact text). False means the prompt has changed since this
   *  session started (an override was set or cleared, or the code moved). */
  personaMatchesCurrent: boolean
}

/** Response for the capture list: `rows` is capped (see capture.ts's DEFAULT_LIST_LIMIT), `total`
 *  is how many records actually exist so the UI can say "showing N of total" instead of
 *  rendering a truncated list as though it were complete. */
export interface PromptCaptureListPayload {
  rows: PromptCaptureSummary[]
  total: number
}
