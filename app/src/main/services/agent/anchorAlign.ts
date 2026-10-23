import type { ProviderTurn } from './driver'
import { CLOSE_TAG } from './historyDigest'

const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim()

/**
 * Whether the provider recorded THIS prompt: the same text, or — for the turn that carried a
 * history digest — the digest followed by it. session.ts sends `digest + text` and the digest
 * ends with `CLOSE_TAG\n\n`, so a digest-carrying turn is precisely "the prompt, preceded by a
 * closed record". Anything looser (a bare suffix, a substring) lets a short prompt such as "ok"
 * match a longer one that merely ends with it.
 */
function recorded(providerText: string, prompt: string): boolean {
  const t = norm(providerText)
  const p = norm(prompt)
  if (t === p) return true
  return (
    t.endsWith(p) &&
    t
      .slice(0, t.length - p.length)
      .trimEnd()
      .endsWith(CLOSE_TAG)
  )
}

/**
 * The provider anchor a branch at Argus turn `anchorIndex` slices at, derived from the
 * provider's own transcript — or null, meaning "take the digest path".
 *
 * `prompts` are the session's LIVE turns' prompts, oldest first, ALL of them (not only those up
 * to the anchor): the alignment is only trusted when it accounts for the whole transcript.
 *
 * Argus turns and provider turns are not 1:1. A local CLI command (`/context`) or a turn that
 * failed before the prompt reached the provider leaves no provider turn; such an Argus turn
 * changes nothing on the provider side, so a branch at it slices where the previous one did.
 *
 * In-order, exact matching only, and no searching ahead: an Argus prompt either is the next
 * provider turn or has none. Every way that can go wrong returns null rather than a guess,
 * because a wrong anchor is silent — the fork simply carries the wrong history:
 *  - a provider turn left unaccounted for (an Argus prompt the provider recorded differently,
 *    e.g. an expanded slash command, consumes nothing and strands it);
 *  - an unmatched prompt identical to a matched one (a failed attempt then its retry — which
 *    of the two the provider turn belongs to cannot be told from text);
 *  - an anchor turn with no matched turn at or before it, or a matched turn with no reply.
 */
export function alignAnchor(
  prompts: string[],
  anchorIndex: number,
  provider: ProviderTurn[]
): string | null {
  if (anchorIndex < 0 || anchorIndex >= prompts.length) return null
  const at: (number | null)[] = []
  let j = 0
  for (const p of prompts) {
    if (j < provider.length && recorded(provider[j].text, p)) at.push(j++)
    else at.push(null)
  }
  if (j !== provider.length) return null
  const matched = new Set(prompts.filter((_, i) => at[i] !== null).map(norm))
  if (prompts.some((p, i) => at[i] === null && matched.has(norm(p)))) return null
  for (let i = anchorIndex; i >= 0; i--) {
    const k = at[i]
    if (k !== null) return provider[k].anchor
  }
  return null
}
