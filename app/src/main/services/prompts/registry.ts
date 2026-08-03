import { MODES } from '../../../shared/modes'
import { REVIEW_LAYERS } from '../../../shared/reviewLayers'
import { REVIEW_RUN_PROMPTS } from '../agent/reviewRun'
import { REVIEW_ACTION_PROMPTS } from '../agent/reviewActions'
import { CI_TRIAGE_PROMPTS } from '../agent/ciTriage'
import { NEUTRAL_PERSONA, DIAGRAM_FRAGMENT, CONTRIBUTE_BACK_NUDGE } from '../agent/persona'
import { NATIVE_TOOL_SPECS, NATIVE_TOOL_DRIVERS, TOOL_FEEDBACK } from '../agent/nativeTools'
import { REVIEW_WRITE_FEEDBACK } from '../agent/reviewWrites'
import { CI_LOG_FEEDBACK } from '../agent/ciLogs'
import { SKILL_INDEX_LEAD } from '../agent/skillIndex'
import { MEMORY_HEADER } from '../agent/session'
import { MEMORY_FEEDBACK } from '../memory'
import { RISK_DENY_REASONS } from '../agent/risk'
import { CASE_WORKING_RULES } from '../caseService'
import { CASE_DISTILL_CONTRACT } from '../distill/caseDistillContract'
import { CASE_DISTILL_SECTIONS } from '../distill/contract'
import { DISTILL_CONTRACT, REF_DISTILL_SECTIONS } from '../refSync/distill'
import {
  SKILL_AUTHORING_CONTRACT,
  REFERENCE_AUTHORING_CONTRACT,
  AUTHORING_SECTIONS
} from '../authoring/prompts'
import { JIRA_PROMPTS } from '../jiraPrompts'
import { PANEL_DRAFTS } from '../panels/draftMessages'
import { TOUR_PROMPTS } from '../../../shared/tourPrompts'
// The category union is an IPC payload type: it lives in shared/ so the renderer can import it
// without reaching into main/. Re-exported below for main-side importers.
import type { PromptCategory } from '../../../shared/promptsIpc'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

export type { PromptCategory }

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
  /** Names of `{name}` tokens in the text. Present only for template entries; an override
   *  that drops one is rejected by `PromptStore.setOverride`. */
  placeholders?: readonly string[]
  /** Required for `external`, forbidden otherwise: where the real text lives. */
  note?: string
}

/** Derive one entry per key of a module's `PromptTextSpecs` record. Used by every category
 *  whose text is a set of short strings rather than one big constant — adding a string to the
 *  module's record registers it, so the catalog cannot fall behind the code. */
export function specEntries(
  specs: PromptTextSpecs,
  opts: {
    prefix: string
    category: PromptCategory
    source: string
    reaches: readonly string[] | 'all'
  }
): PromptEntry[] {
  return Object.entries(specs).map(([key, s]) => ({
    id: `${opts.prefix}.${key}`,
    category: opts.category,
    title: s.title,
    source: opts.source,
    reaches: opts.reaches,
    editable: true,
    default: () => s.text,
    ...(s.placeholders ? { placeholders: s.placeholders } : {})
  }))
}

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

/** Derived from REVIEW_LAYERS for the same reason MODE_PERSONA_ENTRIES is derived from MODES:
 *  a new layer registers itself, and the catalog cannot disagree with the table. Three entries
 *  per layer: identity and task are separately worth overriding — a user who wants "also flag
 *  N+1 queries" edits the prompt, not the persona — and `appliesWhen` is its own entry because
 *  it is model-facing on its own terms: it becomes the compiled subagent's `description` (what
 *  the main agent reads to pick applicable layers) and is rendered into the composed prompt's
 *  layer menu, so it needs the same override seam as the other two, not just a doc comment. */
const REVIEW_LAYER_ENTRIES: PromptEntry[] = Object.values(REVIEW_LAYERS).flatMap((def) => [
  {
    id: `review.layer.${def.id}.persona`,
    category: 'persona' as const,
    title: `Review layer · ${def.label} · identity`,
    source: 'app/src/shared/reviewLayers.ts',
    reaches: 'all' as const,
    editable: true,
    default: () => def.personaFragment
  },
  {
    id: `review.layer.${def.id}.prompt`,
    category: 'persona' as const,
    title: `Review layer · ${def.label} · task`,
    source: 'app/src/shared/reviewLayers.ts',
    reaches: 'all' as const,
    editable: true,
    default: () => def.prompt
  },
  {
    id: `review.layer.${def.id}.applies-when`,
    category: 'persona' as const,
    title: `Review layer · ${def.label} · applies-when`,
    source: 'app/src/shared/reviewLayers.ts',
    reaches: 'all' as const,
    editable: true,
    default: () => def.appliesWhen
  }
])

/** The review-run scaffolding text (header, layer selection, fan-out, triage) — everything a
 *  composed review turn says that is not a layer's own persona/task text. */
const REVIEW_RUN_ENTRIES: PromptEntry[] = specEntries(REVIEW_RUN_PROMPTS, {
  prefix: 'review.run',
  category: 'persona',
  source: 'app/src/main/services/agent/reviewRun.ts',
  reaches: 'all'
})

/** The two finding write-action turns (post a PR comment, apply the change and push). */
const REVIEW_ACTION_ENTRIES: PromptEntry[] = specEntries(REVIEW_ACTION_PROMPTS, {
  prefix: 'review.action',
  category: 'persona',
  source: 'app/src/main/services/agent/reviewActions.ts',
  reaches: 'all'
})

/** The CI-failure analysis turn the companion's Analyze button sends. */
const CI_TRIAGE_ENTRIES: PromptEntry[] = specEntries(CI_TRIAGE_PROMPTS, {
  prefix: 'review.ci',
  category: 'persona',
  source: 'app/src/main/services/agent/ciTriage.ts',
  reaches: 'all'
})

const PERSONA_ENTRIES: PromptEntry[] = [
  ...MODE_PERSONA_ENTRIES,
  ...REVIEW_LAYER_ENTRIES,
  ...REVIEW_RUN_ENTRIES,
  ...REVIEW_ACTION_ENTRIES,
  ...CI_TRIAGE_ENTRIES,
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
    source: 'app/src/main/services/agent/session.ts:142',
    reaches: 'all',
    editable: true,
    default: () => MEMORY_HEADER
  },
  {
    id: 'session.skill-index-lead',
    category: 'session-context',
    title: 'Skill-index lead line',
    source: 'app/src/main/services/agent/skillIndex.ts:15',
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
  source: 'app/src/main/services/agent/nativeTools.ts:725',
  reaches: NATIVE_TOOL_DRIVERS,
  editable: true,
  default: () => s.description
}))

const TOOL_FEEDBACK_ENTRIES: PromptEntry[] = specEntries(TOOL_FEEDBACK, {
  prefix: 'tool-feedback',
  category: 'tool-feedback',
  source: 'app/src/main/services/agent/nativeTools.ts',
  reaches: NATIVE_TOOL_DRIVERS
})

const REVIEW_WRITE_FEEDBACK_ENTRIES: PromptEntry[] = specEntries(REVIEW_WRITE_FEEDBACK, {
  prefix: 'tool-feedback',
  category: 'tool-feedback',
  source: 'app/src/main/services/agent/reviewWrites.ts',
  reaches: NATIVE_TOOL_DRIVERS
})

const CI_LOG_FEEDBACK_ENTRIES: PromptEntry[] = specEntries(CI_LOG_FEEDBACK, {
  prefix: 'tool-feedback',
  category: 'tool-feedback',
  source: 'app/src/main/services/agent/ciLogs.ts',
  reaches: NATIVE_TOOL_DRIVERS
})

const MEMORY_FEEDBACK_ENTRIES: PromptEntry[] = specEntries(MEMORY_FEEDBACK, {
  prefix: 'tool-feedback',
  category: 'tool-feedback',
  source: 'app/src/main/services/memory.ts',
  reaches: NATIVE_TOOL_DRIVERS
})

// Deny reasons reach whichever driver produced the tool call, not only the two that register
// Argus's own MCP tools — the classifier runs over every driver's native tools.
const RISK_FEEDBACK_ENTRIES: PromptEntry[] = specEntries(RISK_DENY_REASONS, {
  prefix: 'tool-feedback',
  category: 'tool-feedback',
  source: 'app/src/main/services/agent/risk.ts',
  reaches: 'all'
})

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
    source: 'app/src/main/services/refSync/distill.ts:18',
    reaches: 'all',
    editable: true,
    default: () => DISTILL_CONTRACT
  },
  {
    id: 'headless.authoring.skill-contract',
    category: 'headless',
    title: 'Skill authoring contract (Draft / Improve)',
    source: 'app/src/main/services/authoring/prompts.ts:5',
    reaches: 'all',
    editable: true,
    default: () => SKILL_AUTHORING_CONTRACT
  },
  {
    id: 'headless.authoring.reference-contract',
    category: 'headless',
    title: 'Reference authoring contract (Draft / Improve)',
    source: 'app/src/main/services/authoring/prompts.ts:17',
    reaches: 'all',
    editable: true,
    default: () => REFERENCE_AUTHORING_CONTRACT
  }
]

const CASE_DISTILL_SECTION_ENTRIES: PromptEntry[] = specEntries(CASE_DISTILL_SECTIONS, {
  prefix: 'headless.case-distill.section',
  category: 'headless',
  source: 'app/src/main/services/distill/contract.ts',
  // Headless runs resolve their own provider (settings.distillProvider) and are driver-blind.
  reaches: 'all'
})

const REF_DISTILL_SECTION_ENTRIES: PromptEntry[] = specEntries(REF_DISTILL_SECTIONS, {
  prefix: 'headless.ref-distill.section',
  category: 'headless',
  source: 'app/src/main/services/refSync/distill.ts',
  reaches: 'all'
})

const AUTHORING_SECTION_ENTRIES: PromptEntry[] = specEntries(AUTHORING_SECTIONS, {
  prefix: 'headless.authoring.section',
  category: 'headless',
  source: 'app/src/main/services/authoring/prompts.ts',
  reaches: 'all'
})

const GENERATED_FILE_ENTRIES: PromptEntry[] = [
  {
    id: 'generated-files.case-working-rules',
    category: 'generated-files',
    title: 'Per-case CLAUDE.md working rules',
    source: 'app/src/main/services/caseService.ts:25',
    // Only the Claude driver loads CLAUDE.md — it sets settingSources:['project'].
    reaches: ['claude-agent-sdk'],
    editable: true,
    default: () => CASE_WORKING_RULES
  }
]

const JIRA_ENTRIES: PromptEntry[] = specEntries(JIRA_PROMPTS, {
  prefix: 'generated-files',
  category: 'generated-files',
  source: 'app/src/main/services/jiraPrompts.ts',
  // Written into an evidence file, so any driver that reads the case sees it.
  reaches: 'all'
})

const SYNTHESIZED_ENTRIES: PromptEntry[] = specEntries(PANEL_DRAFTS, {
  prefix: 'synthesized',
  category: 'synthesized',
  source: 'app/src/main/services/panels/draftMessages.ts',
  reaches: 'all'
})

const TOUR_ENTRIES: PromptEntry[] = specEntries(TOUR_PROMPTS, {
  prefix: 'synthesized',
  category: 'synthesized',
  source: 'app/src/shared/tourPrompts.ts',
  reaches: 'all'
})

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
  ...TOOL_FEEDBACK_ENTRIES,
  ...REVIEW_WRITE_FEEDBACK_ENTRIES,
  ...CI_LOG_FEEDBACK_ENTRIES,
  ...MEMORY_FEEDBACK_ENTRIES,
  ...RISK_FEEDBACK_ENTRIES,
  ...HEADLESS_ENTRIES,
  ...CASE_DISTILL_SECTION_ENTRIES,
  ...REF_DISTILL_SECTION_ENTRIES,
  ...AUTHORING_SECTION_ENTRIES,
  ...GENERATED_FILE_ENTRIES,
  ...JIRA_ENTRIES,
  ...SYNTHESIZED_ENTRIES,
  ...TOUR_ENTRIES,
  ...EXTERNAL_ENTRIES
]

const BY_ID = new Map(PROMPT_ENTRIES.map((e) => [e.id, e]))

export function entryById(id: string): PromptEntry | undefined {
  return BY_ID.get(id)
}
