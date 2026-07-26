import { MODES } from '../../../shared/modes'
import { NEUTRAL_PERSONA, DIAGRAM_FRAGMENT, CONTRIBUTE_BACK_NUDGE } from '../agent/persona'
import { NATIVE_TOOL_SPECS } from '../agent/nativeTools'
import { SKILL_INDEX_LEAD } from '../agent/skillIndex'
import { MEMORY_HEADER } from '../agent/session'
import { CASE_WORKING_RULES } from '../caseService'
import { CASE_DISTILL_CONTRACT } from '../distill/caseDistillContract'
import { DISTILL_CONTRACT } from '../refSync/distill'

export type PromptCategory =
  | 'persona'
  | 'session-context'
  | 'tools'
  | 'tool-feedback'
  | 'headless'
  | 'generated-files'
  | 'synthesized'
  | 'external'

export interface PromptEntry {
  /** Stable id, also the override key in Plan 3. Never renamed without a migration. */
  id: string
  category: PromptCategory
  title: string
  /** Repo-relative `file:line` of the default, for click-through in the UI. */
  source: string
  /** Driver kind slugs that receive this; 'all' = every driver. `DriverDefinition.kind` is
   *  `string`, so there is no union type to reference here. */
  reaches: readonly string[] | 'all'
  /** false for external text: shown because it reaches the model, never edited here. */
  editable: boolean
  /** Read at call time, never cached — an override must not need a restart.
   *  Returns '' only for `category: 'external'`. */
  default: () => string
  /** Required for `external`, forbidden otherwise: where the real text lives. */
  note?: string
}

/** Drivers that register Argus's native MCP tools. Codex and the ACP drivers do not. */
const NATIVE_TOOL_DRIVERS = ['claude-agent-sdk', 'github-copilot'] as const

/** Derived from MODES rather than hand-listed, the same way TOOL_ENTRIES below is derived from
 *  NATIVE_TOOL_SPECS: a new mode gets an entry for free, and the registry can never disagree
 *  with the table it describes. MODES carries no per-mode line number, so the source points at
 *  the file only — a less precise citation is the trade for the entries being generated. */
const MODE_PERSONA_ENTRIES: PromptEntry[] = Object.values(MODES).map((def) => ({
  id: `persona.mode.${def.id}`,
  category: 'persona' as const,
  title: `${def.label} mode identity`,
  source: 'app/src/shared/modes.ts',
  reaches: 'all' as const,
  editable: true,
  default: () => def.personaFragment
}))

const PERSONA_ENTRIES: PromptEntry[] = [
  ...MODE_PERSONA_ENTRIES,
  {
    id: 'persona.neutral',
    category: 'persona',
    title: 'Role-neutral core (citations, findings, workspaces, HITL)',
    source: 'app/src/main/services/agent/persona.ts:12',
    reaches: 'all',
    editable: true,
    default: () => NEUTRAL_PERSONA
  },
  {
    id: 'persona.diagram',
    category: 'persona',
    title: 'Visual-explanation (mermaid) guidance',
    source: 'app/src/main/services/agent/persona.ts:35',
    reaches: 'all',
    editable: true,
    default: () => DIAGRAM_FRAGMENT
  },
  {
    id: 'persona.contribute-back',
    category: 'persona',
    title: 'Contribute-back nudge (only when the skill is enabled)',
    source: 'app/src/main/services/agent/persona.ts:52',
    reaches: 'all',
    editable: true,
    default: () => CONTRIBUTE_BACK_NUDGE
  }
]

const SESSION_ENTRIES: PromptEntry[] = [
  {
    id: 'session.memory-header',
    category: 'session-context',
    title: 'Agent-memory block header',
    source: 'app/src/main/services/agent/session.ts:167',
    reaches: 'all',
    editable: true,
    default: () => MEMORY_HEADER
  },
  {
    id: 'session.skill-index-lead',
    category: 'session-context',
    title: 'Skill-index lead line',
    source: 'app/src/main/services/agent/skillIndex.ts:30',
    reaches: 'all',
    editable: true,
    default: () => SKILL_INDEX_LEAD
  }
]

/** Derived from NATIVE_TOOL_SPECS rather than hand-listed: a new tool gets an entry for free,
 *  and the registry can never disagree with the table it describes. */
const TOOL_ENTRIES: PromptEntry[] = NATIVE_TOOL_SPECS.map((s) => ({
  id: `tool.${s.name}.description`,
  category: 'tools' as const,
  title: `${s.name} — tool description`,
  source: 'app/src/main/services/agent/nativeTools.ts:323',
  reaches: NATIVE_TOOL_DRIVERS,
  editable: true,
  default: () => s.description
}))

const HEADLESS_ENTRIES: PromptEntry[] = [
  {
    id: 'headless.case-distill.contract',
    category: 'headless',
    title: 'Case-close distillation contract',
    source: 'app/src/main/services/distill/caseDistillContract.ts:15',
    // Headless runs resolve their own provider (settings.distillProvider) and are driver-blind.
    reaches: 'all',
    editable: true,
    default: () => CASE_DISTILL_CONTRACT
  },
  {
    id: 'headless.ref-distill.contract',
    category: 'headless',
    title: 'Confluence→reference distillation contract',
    source: 'app/src/main/services/refSync/distill.ts:15',
    reaches: 'all',
    editable: true,
    default: () => DISTILL_CONTRACT
  }
]

const GENERATED_FILE_ENTRIES: PromptEntry[] = [
  {
    id: 'generated-files.case-working-rules',
    category: 'generated-files',
    title: 'Per-case CLAUDE.md working rules',
    source: 'app/src/main/services/caseService.ts:22',
    // Only the Claude driver loads CLAUDE.md — it sets settingSources:['project'].
    reaches: ['claude-agent-sdk'],
    editable: true,
    default: () => CASE_WORKING_RULES
  }
]

/** Prompt text that reaches the model but is not in this repo. Registered because it dominates
 *  the token budget — the claude_code preset alone is larger than everything Argus adds — so a
 *  catalogue that omitted it would misrepresent what the model reads. */
const EXTERNAL_ENTRIES: PromptEntry[] = [
  {
    id: 'external.claude.preset',
    category: 'external',
    title: 'Anthropic claude_code preset system prompt',
    source: 'app/src/main/services/agent/drivers/claude/index.ts:141',
    reaches: ['claude-agent-sdk'],
    editable: false,
    default: () => '',
    note: "Ships inside the Claude Code CLI. Selected as systemPrompt: { type: 'preset', preset: 'claude_code' }; Argus text is only appended to it."
  },
  {
    id: 'external.copilot.base',
    category: 'external',
    title: 'Copilot base system message',
    source: 'app/src/main/services/agent/drivers/copilot/index.ts:387',
    reaches: ['github-copilot'],
    editable: false,
    default: () => '',
    note: "Ships inside the Copilot CLI. Argus passes systemMessage: { mode: 'append' }, so the base is retained and unseen."
  },
  {
    id: 'external.codex.base',
    category: 'external',
    title: 'Codex base instructions',
    source: 'app/src/main/services/agent/drivers/codex/index.ts:289',
    reaches: ['codex'],
    editable: false,
    default: () => '',
    note: 'Ships inside the Codex CLI. Argus passes developerInstructions, which layers on top of it.'
  }
]

export const PROMPT_ENTRIES: readonly PromptEntry[] = [
  ...PERSONA_ENTRIES,
  ...SESSION_ENTRIES,
  ...TOOL_ENTRIES,
  ...HEADLESS_ENTRIES,
  ...GENERATED_FILE_ENTRIES,
  ...EXTERNAL_ENTRIES
]

const BY_ID = new Map(PROMPT_ENTRIES.map((e) => [e.id, e]))

export function entryById(id: string): PromptEntry | undefined {
  return BY_ID.get(id)
}
