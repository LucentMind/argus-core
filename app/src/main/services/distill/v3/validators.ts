import type { ValidatorReason } from '../../../../shared/distillV3'
import { fmBlock, fmField } from '../../../../shared/frontmatter'
import { ASSET_NAME_RE } from '../../../../shared/assetValidation'
import { BASIS_MIN_CHARS } from '../staging'

export interface MaterializedProposal {
  type: 'skill-new' | 'skill-edit' | 'reference-edit'
  target: string
  content: string
  basis: string
  /** the pre-edit file for skill-edit / reference-edit */
  original?: string
  /** true when the model used the whole_file escape hatch (broad-edit becomes a flag, not a drop) */
  wholeFileUsed: boolean
}

export type ValidateResult =
  { ok: true; flags: ValidatorReason[] } | { ok: false; reason: ValidatorReason }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Coarse locality measure: number of changed hunks + deleted-line ratio, on a line LCS-free
 *  diff (set-difference by line). Good enough to catch a rewrite; not a real diff. Scattered
 *  small edits (>2 hunks) are flagged by design — a coarse heuristic, this false-positive shape
 *  (many tiny, genuinely-local edits) is an accepted tradeoff, not a bug.
 *  Blank lines and bare `---`/`***` separators are filtered out of both sides before comparing:
 *  otherwise they match for free in the multiset and dilute deletedRatio, letting a full rewrite
 *  of a short substantive block inside a filler-heavy file slip under the threshold. */
function editLocality(original: string, edited: string): { hunks: number; deletedRatio: number } {
  const isFiller = (l: string): boolean => {
    const t = l.trim()
    return t === '' || t === '---' || t === '***'
  }
  const a = original
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !isFiller(l))
  const b = edited
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !isFiller(l))
  const bSet = new Map<string, number>()
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1)
  let deleted = 0
  let hunks = 0
  let inHunk = false
  for (const l of a) {
    const n = bSet.get(l) ?? 0
    if (n > 0) {
      bSet.set(l, n - 1)
      inHunk = false
    } else {
      deleted++
      if (!inHunk) {
        hunks++
        inHunk = true
      }
    }
  }
  return { hunks, deletedRatio: a.length ? deleted / a.length : 0 }
}

export function validateMaterialized(
  p: MaterializedProposal,
  caseIds: { slug: string; jiraKey: string | null }
): ValidateResult {
  if (!ASSET_NAME_RE.test(p.target)) return { ok: false, reason: 'bad-name' }
  if (p.basis.trim().length < BASIS_MIN_CHARS) return { ok: false, reason: 'basis' }
  const fm = fmBlock(p.content)
  if (p.type === 'skill-new' || p.type === 'skill-edit') {
    if (!fm) return { ok: false, reason: 'frontmatter' }
    if (fmField(fm.fm, 'name') !== p.target || !fmField(fm.fm, 'description'))
      return { ok: false, reason: 'frontmatter' }
  }
  const body = fm ? fm.body : p.content
  const idRe = new RegExp(
    `\\b(${[escapeRe(caseIds.slug), ...(caseIds.jiraKey ? [escapeRe(caseIds.jiraKey)] : [])].join('|')})\\b`,
    'i'
  )
  // The `description:` line sits in the frontmatter, i.e. OUTSIDE `body` — and it is the single
  // string a future agent matches a skill on, so a case slug or ticket key leaking there is at
  // least as damaging as one in the body. Checked separately rather than by scanning the whole
  // frontmatter: `name:` is the target, which may legitimately look id-ish.
  const description = fm ? (fmField(fm.fm, 'description') ?? '') : ''
  if (idRe.test(body) || idRe.test(description)) return { ok: false, reason: 'case-identifiers' }
  if (p.type === 'reference-edit' && (body.match(/^\s*\d+\.\s/gm)?.length ?? 0) >= 3)
    return { ok: false, reason: 'steps-in-reference' }
  const flags: ValidatorReason[] = []
  if (p.original !== undefined) {
    const ofm = fmBlock(p.original)
    if (ofm && fm) {
      const stripDesc = (s: string): string =>
        s
          .split(/\r?\n/)
          .filter((l) => !/^description:/.test(l))
          .join('\n')
      if (stripDesc(ofm.fm) !== stripDesc(fm.fm))
        return p.wholeFileUsed
          ? { ok: true, flags: ['broad-edit'] }
          : { ok: false, reason: 'broad-edit' }
    }
    const { hunks, deletedRatio } = editLocality(p.original, p.content)
    if (hunks > 2 || deletedRatio > 0.2) {
      if (!p.wholeFileUsed) return { ok: false, reason: 'broad-edit' }
      flags.push('broad-edit')
    }
  }
  return { ok: true, flags }
}
