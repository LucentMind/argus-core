/**
 * The quick-open scorer (spec §6.2). A local subsequence matcher with a word-boundary bonus —
 * deliberately not a dependency, and deliberately **greedy** rather than optimal: it takes the
 * first legal subsequence rather than searching for the best-scoring one. Optimal matching is
 * O(query × target) with a DP table, and the corpus here is tens of files with short names.
 */
export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches on the SAME query. */
  score: number
  /** Indices into `target`, ascending. Empty for an empty query. */
  positions: number[]
}

/** A char that starts a word: the first char, or one following a separator. */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true
  return /[-_/.\s]/.test(target[i - 1]!)
}

const BOUNDARY_BONUS = 8
const RUN_BONUS = 4
const BASE = 1
/** Subtracted once per leading character skipped, so an earlier match wins a tie. Capped so a
 *  long path prefix cannot drive an otherwise good match negative. */
const LEAD_PENALTY = 0.5
const LEAD_PENALTY_CAP = 10

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === '') return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const positions: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const hit = t.indexOf(ch, ti)
    if (hit === -1) return null
    positions.push(hit)
    score += BASE
    if (isBoundary(target, hit)) score += BOUNDARY_BONUS
    if (hit === prev + 1) score += RUN_BONUS
    prev = hit
    ti = hit + 1
  }
  score -= Math.min(positions[0]! * LEAD_PENALTY, LEAD_PENALTY_CAP)
  return { score, positions }
}
