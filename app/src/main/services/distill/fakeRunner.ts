import fs from 'node:fs'
import path from 'node:path'
import type { HeadlessAgentResult, HeadlessResult, HeadlessUsage } from '../agent/driver'
import type { HeadlessAgentRunnerFn } from './caseDistiller'
import { CASE_DISTILL_CONTRACT } from './caseDistillContract'
import { DIGEST_PROMPT } from './rejectDigest'
import { RCA_CONTRACT } from '../rca/contract'
import { ATTRIBUTION_CONTRACT } from './v3/attribution'
import { CANDIDATES_CONTRACT } from './v3/candidates'
import { DOSSIER_CONTRACT, DOSSIER_LITE_CONTRACT } from './v3/dossier'
import { MATERIALIZE_CONTRACT } from './v3/materialize'
import type { PipelineRunners } from './v3/pipeline'
import { SUMMARY_CONTRACT } from './v3/summary'

/**
 * A fake for the two headless runners the distillation pipeline and the RCA drafter call (spec
 * §4.1): it recognises which stage a prompt belongs to and which case it is about, then answers
 * from canned per-case fixtures, so the whole pipeline runs without the Claude SDK. Electron-free on purpose — it only
 * touches `node:fs`/`node:path`, so tests and the dev-tools seam in main/index.ts share it.
 *
 * Stage recognition is derived from the real contract constants, never retyped: a prompt starts
 * with its contract, so the contract's first sentence names the stage. Editing a contract's
 * prose therefore cannot silently orphan this module.
 */

export type FakeStage =
  | 'dossier'
  | 'dossierLite'
  | 'summary'
  | 'candidates'
  | 'attribution'
  | 'materialize'
  | 'v2'
  | 'rejectDigest'
  | 'rca'
export interface FakeStageSpec {
  text?: string
  throw?: string
  capHit?: 'iterations' | 'timeout'
  capSubtype?: string
  usage?: Partial<HeadlessUsage>
  turnCount?: number
  toolCallCount?: number
}
export type FakeCaseStages = Partial<Record<FakeStage, FakeStageSpec>>
export type FakeSource = { dir: string } | { cases: Map<string, FakeCaseStages> }
export interface FakeRunners {
  oneShot: PipelineRunners['oneShot']
  agent: HeadlessAgentRunnerFn
}

export const ONE_SHOT_DEFAULT_USAGE: HeadlessUsage = {
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.01,
  durationMs: 10
}
export const AGENT_DEFAULT_USAGE: HeadlessUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  costUsd: 0.5,
  durationMs: 100
}
export const FAKE_CALLS_FILE = 'calls.ndjson'
/** What every reject-digest call returns (the digest belongs to no case, so no fixture entry is
 *  consulted): the digest is a bullet list, and the rebuild refuses a response with no "- " line. */
export const DEFAULT_DIGEST_TEXT = '- Cite the evidence behind every proposal.'

const AGENT_STAGES: ReadonlySet<FakeStage> = new Set(['dossier', 'dossierLite', 'v2'])

/** Text up to and including the first `.` followed by whitespace or the end of the string. */
const firstSentence = (contract: string): string =>
  /^[\s\S]*?\.(?=\s|$)/.exec(contract)?.[0] ?? contract

// The lite and full dossier prompts share their first sentence and are told apart by which
// whole contract the prompt opens with. That only works while a full prompt cannot also open
// with the lite contract, so check it at load time: it follows any edit to either constant.
if (
  DOSSIER_LITE_CONTRACT === DOSSIER_CONTRACT ||
  DOSSIER_CONTRACT.startsWith(DOSSIER_LITE_CONTRACT)
)
  throw new Error('fake runner: DOSSIER_LITE_CONTRACT does not differ from DOSSIER_CONTRACT')
const DOSSIER_HEAD = firstSentence(DOSSIER_CONTRACT)
const STAGE_HEADS: [FakeStage, string][] = [
  ['summary', firstSentence(SUMMARY_CONTRACT)],
  ['candidates', firstSentence(CANDIDATES_CONTRACT)],
  ['attribution', firstSentence(ATTRIBUTION_CONTRACT)],
  ['materialize', firstSentence(MATERIALIZE_CONTRACT)],
  ['v2', firstSentence(CASE_DISTILL_CONTRACT)],
  ['rejectDigest', firstSentence(DIGEST_PROMPT)],
  ['rca', firstSentence(RCA_CONTRACT)]
]

export function stageOf(prompt: string): FakeStage | null {
  // The lite and full dossier share their first sentence; the whole contract tells them apart.
  // `startsWith`, not `includes`: a full prompt can inline lite-contract text in its body.
  if (prompt.startsWith(DOSSIER_HEAD))
    return prompt.startsWith(DOSSIER_LITE_CONTRACT) ? 'dossierLite' : 'dossier'
  return STAGE_HEADS.find(([, head]) => prompt.startsWith(head))?.[0] ?? null
}

export function slugOf(prompt: string): string | null {
  return /^slug: (.+)$/m.exec(prompt)?.[1].trim() ?? null
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

export function createFakeRunners(
  src: FakeSource,
  opts: { log?: (line: string) => void } = {}
): FakeRunners {
  // The materialize prompt has no `# Case` section, so it inherits the slug of the last prompt
  // that had one. Per-instance: concurrent pipelines would need one fake each.
  let sticky: string | null = null

  const loadCase = (slug: string): FakeCaseStages | null => {
    if ('cases' in src) return src.cases.get(slug) ?? null
    const file = path.join(src.dir, `${slug}.json`)
    // Read on every call: a live gate rewrites the fixture between runs.
    return fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as FakeCaseStages)
      : null
  }

  async function serve(
    kind: 'agent' | 'oneShot',
    prompt: string,
    signal?: AbortSignal
  ): Promise<{ spec: FakeStageSpec; defaulted: boolean }> {
    if (signal?.aborted) throw abortError()
    const stage = stageOf(prompt)
    if (!stage)
      throw new Error(`fake runner: unrecognised prompt (starts "${prompt.slice(0, 80)}")`)
    if (AGENT_STAGES.has(stage) !== (kind === 'agent'))
      throw new Error(
        `fake runner: ${stage} is ${kind === 'agent' ? 'a one-shot stage, not an agent stage' : 'an agent stage, not a one-shot stage'}`
      )
    // The digest summarises every case's rejects, so it belongs to no case: it never borrows the
    // sticky slug (that would credit a digest call to whichever case ran last) and always
    // answers the default bullet list.
    const digest = stage === 'rejectDigest'
    const own = digest ? null : slugOf(prompt)
    if (own) sticky = own
    const slug = digest ? null : (own ?? sticky)
    if (!slug && !digest) throw new Error('fake runner: no slug in prompt and no previous slug')
    const stages = slug ? loadCase(slug) : null
    const found = digest
      ? undefined
      : (stages?.[stage] ?? (stage === 'dossierLite' ? stages?.dossier : undefined))
    if (!found && !digest) throw new Error(`fake runner: no fixture for ${slug}/${stage}`)
    const spec: FakeStageSpec = found ?? { text: DEFAULT_DIGEST_TEXT }
    const defaulted = !found
    const mode = defaulted
      ? 'default-digest'
      : spec.throw !== undefined
        ? 'throw'
        : kind === 'agent' && spec.capHit
          ? 'capHit'
          : 'text'
    const line = JSON.stringify({ at: new Date().toISOString(), stage, slug, mode })
    if ('dir' in src) fs.appendFileSync(path.join(src.dir, FAKE_CALLS_FILE), line + '\n')
    opts.log?.(line)
    if (spec.throw !== undefined) throw new Error(spec.throw)
    return { spec, defaulted }
  }

  return {
    async oneShot(prompt, o): Promise<HeadlessResult> {
      const { spec } = await serve('oneShot', prompt, o?.signal)
      return { text: spec.text ?? '', usage: { ...ONE_SHOT_DEFAULT_USAGE, ...spec.usage } }
    },
    async agent(prompt, o): Promise<HeadlessAgentResult> {
      const { spec } = await serve('agent', prompt, o.signal)
      const base = {
        usage: { ...AGENT_DEFAULT_USAGE, ...spec.usage },
        turnCount: spec.turnCount ?? 1,
        toolCallCount: spec.toolCallCount ?? 0,
        trajectory: []
      }
      return spec.capHit
        ? {
            text: spec.text ?? '',
            ...base,
            capHit: spec.capHit,
            ...(spec.capSubtype ? { capSubtype: spec.capSubtype } : {})
          }
        : { text: spec.text ?? '', ...base }
    }
  }
}

/** The dev seam: `ARGUS_HEADLESS_FAKE=<fixture dir>` swaps in the fake, but only with dev tools
 *  on — a stray variable must never replace the real model in a user's install. */
export function resolveFakeRunners(deps: {
  env: NodeJS.ProcessEnv
  devTools: boolean
  warn: (msg: string) => void
  info?: (msg: string) => void
}): FakeRunners | null {
  const dir = deps.env.ARGUS_HEADLESS_FAKE
  if (!dir) return null
  if (!deps.devTools) {
    deps.warn('[distill] ARGUS_HEADLESS_FAKE ignored: dev tools are not enabled')
    return null
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    deps.warn(`[distill] ARGUS_HEADLESS_FAKE ignored: directory does not exist: ${dir}`)
    return null
  }
  deps.info?.(`[distill] FAKE RUNNER active: ${dir}`)
  return createFakeRunners({ dir })
}
