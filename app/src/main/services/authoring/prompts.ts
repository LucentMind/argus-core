import { fillPrompt } from '../prompts/fill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import type { AuthoringRequest } from '../../../shared/authoringIpc'

export const SKILL_AUTHORING_CONTRACT = `You are writing a SKILL.md file for Argus, an RCA (root-cause-analysis) toolkit. A skill is a short instruction file an agent loads when its description matches the task at hand.

Rules — follow every one:
1. Output the COMPLETE file: a --- fenced YAML frontmatter block, then the markdown body. No commentary, no code fence around the whole file.
2. Frontmatter carries exactly \`name\` and \`description\`, plus \`roles\` only when the skill is specific to one role.
3. \`name\` MUST be the target name you are given, character for character. It is the folder name and a mismatch is rejected.
4. \`description\` is the trigger. Write it as "Use when …" and name the concrete situation, the tools or artifacts involved, and the words a user would actually say. This single line decides whether the skill ever loads — a vague description means it never fires.
5. \`roles\` accepts \`triage\` and \`review\`. Omit the key entirely for a skill that applies to both.
6. The body states WHEN to use it, then the method as numbered steps. Prefer imperative steps over prose. Keep it under 100 lines.
7. Name real signals verbatim — log tags, error strings, config keys, file paths, CLI commands — in code spans or fenced blocks.
8. Do not invent Argus features, tool names, or file paths you were not given.`

export const REFERENCE_AUTHORING_CONTRACT = `You are writing a reference file for Argus, an RCA (root-cause-analysis) toolkit. Reference files carry durable system behavior: how components work, what signals mean, how to operate the system.

Rules — follow every one:
1. Output the COMPLETE file body as markdown. No YAML frontmatter, no commentary, no code fence around the whole file. Argus stamps the frontmatter itself.
2. Start with the H1 title line, then a one-sentence overview paragraph — it seeds the references index.
3. Keep SIGNAL PATTERNS VERBATIM: log tags, error strings, regexes, IDs, config keys, file paths and CLI commands must be copied exactly, in code spans or fenced blocks.
4. Durable facts only. No incident narrative, no meeting notes, no case-specific detail tied to one ticket.
5. Do not invent behavior you were not given.`

export const AUTHORING_SECTIONS: PromptTextSpecs = {
  'draft-target': {
    title: 'Authoring section — draft target',
    text: '# Target: {name}',
    placeholders: ['name']
  },
  'draft-request': {
    title: 'Authoring section — what the human asked for',
    text: '# What it should do'
  },
  'draft-nudge': {
    title: 'Authoring — closing draft instruction',
    text: 'Return ONLY the complete file for {name}.',
    placeholders: ['name']
  },
  'improve-target': {
    title: 'Authoring section — improve target',
    text: '# Target: {name}',
    placeholders: ['name']
  },
  'improve-instruction': {
    title: 'Authoring — improve instruction',
    text: "Improve the file below. Sharpen the description so it triggers on the right situations, tighten the structure, and remove padding. Preserve the author's intent and every verbatim signal pattern. Do not change the frontmatter name."
  },
  'improve-nudge': {
    title: 'Authoring — closing improve instruction',
    text: 'Return ONLY the complete improved file for {name}.',
    placeholders: ['name']
  }
}

function contractFor(kind: AuthoringRequest['kind'], resolve?: (id: string) => string): string {
  const id =
    kind === 'skill' ? 'headless.authoring.skill-contract' : 'headless.authoring.reference-contract'
  const fallback = kind === 'skill' ? SKILL_AUTHORING_CONTRACT : REFERENCE_AUTHORING_CONTRACT
  return resolve ? resolve(id) : fallback
}

function section(key: string, name: string, resolve?: (id: string) => string): string {
  const text = resolve ? resolve(`headless.authoring.section.${key}`) : AUTHORING_SECTIONS[key].text
  return fillPrompt(text, { name })
}

export function buildDraftPrompt(
  input: AuthoringRequest,
  resolve?: (id: string) => string
): string {
  return [
    contractFor(input.kind, resolve),
    section('draft-target', input.name, resolve),
    `${section('draft-request', input.name, resolve)}\n\n${input.text}`,
    section('draft-nudge', input.name, resolve)
  ].join('\n\n')
}

export function buildImprovePrompt(
  input: AuthoringRequest,
  resolve?: (id: string) => string
): string {
  return [
    contractFor(input.kind, resolve),
    section('improve-target', input.name, resolve),
    section('improve-instruction', input.name, resolve),
    input.text,
    section('improve-nudge', input.name, resolve)
  ].join('\n\n')
}
