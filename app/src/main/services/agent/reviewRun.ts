import {
  REVIEW_LAYERS,
  REVIEW_LAYER_ORDER,
  CANDIDATE_CONTRACT,
  type ReviewLayerId
} from '../../../shared/reviewLayers'
import type { SubagentSupport } from '../../../shared/drivers'
import { compileLayerAgents } from './reviewSubagents'
import { fillPrompt } from '../prompts/fill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

/** The run scaffolding — everything the composed turn says that is NOT a layer's own text.
 *  Registered as `review.run.*` so it is editable like every other model-facing string. */
export const REVIEW_RUN_PROMPTS: PromptTextSpecs = {
  header: {
    title: 'Review run — header',
    text: `Review pull request {prUrl}.

Its head is checked out at {worktreePath}. Diff it against its merge-base with the target
branch; that diff is the review's scope. Nothing outside the changed lines is in scope.`,
    placeholders: ['prUrl', 'worktreePath']
  },
  'choose-layers': {
    title: 'Review run — layer selection (agent chooses)',
    text: `Decide which of these review layers this PR actually needs, then run those:

{layerMenu}

Skip a layer whose applicability does not hold — a docs-only diff does not need a security
pass. Say which layers you chose and why, in one line, before you start.`,
    placeholders: ['layerMenu']
  },
  'pinned-layers': {
    title: 'Review run — layer selection (user pinned)',
    text: `The user pinned these layers; run exactly these and no others:

{layerMenu}`,
    placeholders: ['layerMenu']
  },
  'fanout-configurable': {
    title: 'Review run — fan-out (driver can register agents)',
    text: `Each layer is available as a subagent you can delegate to by name. A layer subagent
starts with no context beyond what you send it and cannot read this turn — your delegation
message to each one must state the worktree path and the diff scope (the PR and its
merge-base, from above) so it knows what to read. Dispatch the layers you chose in parallel,
one subagent per layer, and wait for all of them.

Delegate when the diff is large or spans several concerns. For a small, single-concern diff,
running the passes yourself is faster and cheaper — each subagent re-reads the diff at full
cost. Use your judgement; do not fan out by reflex.`
  },
  'fanout-promptable': {
    title: 'Review run — fan-out (driver cannot register agents)',
    text: `Run each layer you chose as its own separate pass, in order, finishing one before
starting the next. You are running each pass yourself — this driver has no way to register a
separate subagent to delegate to.

The instructions below describe what to look for in each pass — they still apply. You have
append_finding, and you record survivors with it yourself once you've triaged across all
passes, per the steps below.

{layerBodies}`,
    placeholders: ['layerBodies']
  },
  triage: {
    title: 'Review run — triage and record',
    text: `When every layer has reported, triage the candidates yourself before recording
anything:

1. Dedup — several layers often find one issue from different angles. Merge those into a
   single finding rather than recording each.
2. Refute — for each surviving candidate, go back to the cited code and try to prove it wrong.
   Drop what you cannot verify. A short review of real issues beats a long one.
3. Denoise — drop pre-existing issues, style, anything a linter or CI already catches, and
   anything a senior engineer would not raise.
4. Record — call append_finding once per survivor, with layer, severity
   (critical|major|minor) and a [<repo-name>/<path>:<line>] citation into the changed lines.
   Every finding states the concrete failure scenario. No scenario, no finding.

Then end with the verdict — ready / ready with fixes / not ready — and one sentence of
reasoning. Do not change any code; applying a fix happens only when the user accepts a
finding and asks for it.`
  }
}

/**
 * Strips the delegate-only candidate contract ("Return candidates only — do NOT record
 * findings. You have no findings tool. … Emit nothing else.") from an inlined layer body.
 * Used only on the promptable path, where the layer text is inlined into the SAME turn as the
 * agent that runs it — that agent DOES have `append_finding` and is told exactly how to use it
 * by the shared `triage` text a few paragraphs later, so leaving the delegate contract in would
 * tell it the opposite (finding 1 of the layered-review review). A no-op if the resolved text
 * doesn't end with the shipped contract (e.g. a pack override changed it); the fanout-promptable
 * header text above `{layerBodies}` is the fallback framing for that case.
 */
function stripCandidateContract(text: string): string {
  const idx = text.lastIndexOf(CANDIDATE_CONTRACT)
  if (idx === -1) return text
  return text.slice(0, idx).trimEnd()
}

/** Compose the turn a Review run sends. Pure; `resolve` is the prompt-registry seam. */
export function buildReviewRunPrompt(opts: {
  support: SubagentSupport
  /** Empty = the agent picks. */
  pinnedLayers: readonly ReviewLayerId[]
  prUrl: string
  worktreePath: string
  resolve?: (id: string) => string
}): string {
  const r = opts.resolve
  const text = (key: string): string => (r ? r(`review.run.${key}`) : REVIEW_RUN_PROMPTS[key].text)
  const layers = opts.pinnedLayers.length > 0 ? opts.pinnedLayers : REVIEW_LAYER_ORDER
  const agents = compileLayerAgents(layers, r)

  const layerMenu = agents
    .map((a, i) => `- ${a.name} — ${REVIEW_LAYERS[layers[i]].label}: ${a.description}`)
    .join('\n')

  const selection = fillPrompt(
    text(opts.pinnedLayers.length > 0 ? 'pinned-layers' : 'choose-layers'),
    { layerMenu }
  )

  const fanout =
    opts.support === 'configurable'
      ? text('fanout-configurable')
      : fillPrompt(text('fanout-promptable'), {
          layerBodies: agents
            .map((a) => `### ${a.name}\n${stripCandidateContract(a.prompt)}`)
            .join('\n\n')
        })

  return [
    fillPrompt(text('header'), { prUrl: opts.prUrl, worktreePath: opts.worktreePath }),
    selection,
    fanout,
    text('triage')
  ].join('\n\n')
}
