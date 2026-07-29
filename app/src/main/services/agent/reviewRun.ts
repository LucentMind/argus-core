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
    text: `Review **[{prLabel}]({prUrl})** — its head is checked out at \`{worktreePath}\`, scoped
to its diff against the merge-base with the target branch. Nothing outside the changed lines is
in scope.`,
    placeholders: ['prLabel', 'prUrl', 'worktreePath']
  },
  'choose-layers': {
    title: 'Review run — layer selection (agent chooses)',
    text: `**Layers** — decide which of these this PR actually needs, then run those:

{layerMenu}

Skip a layer whose applicability does not hold — a docs-only diff needs no security pass. Say
which you chose and why, in one line, before you start.`,
    placeholders: ['layerMenu']
  },
  'pinned-layers': {
    title: 'Review run — layer selection (user pinned)',
    text: `**Layers** — the user pinned these; run exactly these and no others:

{layerMenu}`,
    placeholders: ['layerMenu']
  },
  'fanout-configurable': {
    title: 'Review run — fan-out (driver can register agents)',
    text: `Each layer is a subagent you can delegate to by name. A layer subagent cannot read this
turn — your delegation message must state the worktree path and the diff scope. Dispatch your
chosen layers in parallel and wait for all of them; for a small single-concern diff, running the
passes yourself is cheaper — use your judgement.`
  },
  'fanout-promptable': {
    title: 'Review run — fan-out (driver cannot register agents)',
    text: `Run each layer you chose as its own separate pass, in order — this driver cannot
register subagents, so you run every pass yourself using the instructions below, and you record
survivors with append_finding after triaging across all passes.

{layerBodies}`,
    placeholders: ['layerBodies']
  },
  triage: {
    title: 'Review run — triage and record',
    text: `When every layer has reported, triage per your review method (dedup across layers,
refute, denoise), then record each survivor with append_finding:

- layer, severity, and a \`[{repoName}/<path>:<line>]\` citation into the changed lines — the prefix is exactly {repoName}, NOT the worktree directory's name, which is a different string
- suggested_change when you know the concrete fix (it is what the user's Apply action implements)
- comment_body: the finding rewritten for the PR author, publishable as-is

End with your verdict — ready / ready with fixes / not ready — and one sentence of reasoning.
Do not change any code.`,
    placeholders: ['repoName']
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
  /** `owner/repo#number` — the header's link text, e.g. `acme/widget#42`. */
  prLabel: string
  prUrl: string
  worktreePath: string
  /** The GitHub repo name — the citation prefix `resolveCommentTarget` strips. Stated
   *  literally in the triage step because the worktree directory the agent reads from is
   *  named differently (`<repo>-<case>-pr<n>`) and it will otherwise cite that. */
  repoName: string
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
    fillPrompt(text('header'), {
      prLabel: opts.prLabel,
      prUrl: opts.prUrl,
      worktreePath: opts.worktreePath
    }),
    selection,
    fanout,
    fillPrompt(text('triage'), { repoName: opts.repoName })
  ].join('\n\n')
}
