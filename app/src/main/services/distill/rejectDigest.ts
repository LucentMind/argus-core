import fs from 'node:fs'
import path from 'node:path'
import { proposalsDir } from '../paths'
import { listArchivedProposals } from '../proposals'
import { fmBlock, fmField, withFrontmatter } from '../../../shared/frontmatter'
import type { HeadlessResult } from '../agent/driver'

/** Most recent rejected proposals fed into one digest rebuild — bounds prompt size regardless
 *  of how large the reject archive grows. */
export const DIGEST_REJECT_WINDOW = 50
/** Truncation caps enforced in CODE on the LLM's output — never trusted to the model, however
 *  clearly the prompt asks for them. */
export const DIGEST_MAX_BULLETS = 8
export const DIGEST_MAX_CHARS = 1_500
/** How many NEW rejects (since the digest file's own `reject_count`) make it stale. */
export const DIGEST_TRIGGER_NEW_REJECTS = 5
/** Sentinel `case_slug` for reject-digest job rows — satisfies the table's `case_slug NOT NULL`
 *  without belonging to any real case. No case is ever named this (case slugs come from
 *  ASSET_NAME_RE-validated user input / Jira keys, never a `__`-wrapped literal). */
export const DIGEST_CASE_SLUG = '__reject-digest__'

/** Exported so other readers of `proposals/` (e.g. `proposalsWatch.ts`, which must NOT treat a
 *  digest rebuild as a reviewable-proposal change) can name this file without duplicating the
 *  string. */
export const DIGEST_FILE = 'reject-patterns.md'

/** Shape returned by `listArchivedProposals`, referenced by name so this module doesn't need
 *  its own parallel type that could drift from the real one. */
type ArchivedProposal = ReturnType<typeof listArchivedProposals>[number]

/** Ship verbatim — this exact wording is the reviewed prompt contract (task-13 brief). The
 *  stats block from `buildRejectStats` is appended after a blank line. */
export const DIGEST_PROMPT = `You are compressing human review feedback on knowledge proposals into standing guidance
for the proposal-drafting model. Below are reject statistics and reviewer notes.
Write at most 8 instruction-shaped bullets (each starting "- ") naming the failure
patterns to avoid. Generalize; never mention specific cases or targets. Output only the bullets.`

/**
 * Deterministic (no LLM involved) stats block: counts of rejects by reason tag and by proposal
 * type, plus every reviewer note verbatim (tagged with its reason+type so the model can tell
 * which failure pattern a note belongs to). Golden-tested — the exact text is part of the
 * prompt contract, so its shape must not drift silently.
 */
export function buildRejectStats(rejects: ArchivedProposal[]): string {
  const byTag = new Map<string, number>()
  const byType = new Map<string, number>()
  const notes: string[] = []
  for (const r of rejects) {
    const tag = r.rejectReason ?? 'unspecified'
    byTag.set(tag, (byTag.get(tag) ?? 0) + 1)
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
    if (r.rejectNote) notes.push(`${tag} ${r.type}: ${r.rejectNote}`)
  }
  const sortEntries = (m: Map<string, number>): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines = [
    `Total rejected proposals analyzed: ${rejects.length}`,
    '',
    'By reject reason:',
    ...sortEntries(byTag).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'By proposal type:',
    ...sortEntries(byType).map(([k, v]) => `- ${k}: ${v}`)
  ]
  if (notes.length > 0) lines.push('', 'Reviewer notes:', ...notes.map((n) => `- ${n}`))
  return lines.join('\n')
}

/** Keeps only lines starting `- ` (the model was told to output only bullets, but this is
 *  enforced defensively, not trusted), caps their count at `DIGEST_MAX_BULLETS`, and caps the
 *  joined text at `DIGEST_MAX_CHARS` — dropping whole trailing lines rather than cutting one
 *  mid-line, so every kept line still starts `- `. */
function truncateDigestText(raw: string): string {
  const bulletLines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith('- '))
  const kept: string[] = []
  let len = 0
  for (const line of bulletLines) {
    if (kept.length >= DIGEST_MAX_BULLETS) break
    const next = len === 0 ? line.length : len + 1 + line.length
    if (next > DIGEST_MAX_CHARS) break
    kept.push(line)
    len = next
  }
  return kept.join('\n')
}

/** Reads `<ARGUS_HOME>/proposals/reject-patterns.md`. `null` when it has never been built. */
export function readRejectDigest(
  argusHome: string
): { builtAt: string; rejectCount: number; text: string } | null {
  const p = path.join(proposalsDir(argusHome), DIGEST_FILE)
  if (!fs.existsSync(p)) return null
  const block = fmBlock(fs.readFileSync(p, 'utf8'))
  if (!block) return null
  // A missing/malformed `reject_count` (hand-edited file, future format change, corruption)
  // must not turn into NaN — every arithmetic use of this field (`digestStale`'s subtraction)
  // would silently propagate NaN, and `NaN >= DIGEST_TRIGGER_NEW_REJECTS` is always false,
  // permanently wedging the digest as "never stale". Treat it as 0 (never built) instead, which
  // fails toward rebuilding rather than toward silently going stale forever.
  const parsedCount = Number(fmField(block.fm, 'reject_count'))
  return {
    builtAt: fmField(block.fm, 'built_at'),
    rejectCount: Number.isFinite(parsedCount) ? parsedCount : 0,
    text: block.body.replace(/\r?\n+$/, '')
  }
}

/**
 * `existing.reject_count` (0 if the file has never been built) plus `DIGEST_TRIGGER_NEW_REJECTS`
 * or more new rejects since the last build makes the digest worth rebuilding.
 */
export function digestStale(argusHome: string, totalRejects: number): boolean {
  const existing = readRejectDigest(argusHome)
  const builtAtCount = existing?.rejectCount ?? 0
  return totalRejects - builtAtCount >= DIGEST_TRIGGER_NEW_REJECTS
}

/**
 * Rebuilds the reject-pattern digest: reads the (up to `DIGEST_REJECT_WINDOW` most recent)
 * archived rejects straight off disk via `listArchivedProposals` — no DI needed, this is a pure
 * read of the same argusHome the caller already has — turns them into a deterministic stats
 * block, asks the one-shot LLM (`run`) to compress that into standing guidance, truncates the
 * response defensively (never trusting the model's own "at most 8 bullets" compliance), and
 * writes the result to `reject-patterns.md`. `totalRejects` is the count the caller already
 * computed (matching whatever triggered this rebuild) and becomes the file's `reject_count`,
 * against which the NEXT staleness check is measured. `jobId`, when given, is stamped as `job`
 * — the digest job that produced this file, the same convention `writeProposal`'s `job` extraFm
 * uses for case proposals. `opts.signal`, when given, is forwarded to `run` so a cancelled
 * digest job can actually abort the in-flight LLM call, not just get its result discarded.
 *
 * Throws — writes NOTHING — if the model's response truncates to an EMPTY digest (no line
 * started `- `, or even the first bullet alone busts `DIGEST_MAX_CHARS`). Without this guard the
 * write below is unconditional: a bad/empty model response would silently clobber a perfectly
 * good previous digest with an empty one, AND still advance `reject_count` to `totalRejects` —
 * which makes `digestStale` go false, permanently hiding the failure until 5 more rejects land.
 * Treating an empty result as a thrown error instead means the queue records the job `failed`
 * (Task 13's `runJob` digest branch) and the previous file — and its `reject_count` — survives
 * untouched, so the very next stale-triggering enqueue retries the rebuild.
 */
export async function rebuildRejectDigest(
  argusHome: string,
  run: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<HeadlessResult>,
  totalRejects: number,
  jobId?: number,
  opts?: { signal?: AbortSignal }
): Promise<void> {
  const rejects = listArchivedProposals(argusHome)
    .filter((p) => p.status === 'rejected')
    .sort((a, b) => (b.rejectedAt ?? b.date).localeCompare(a.rejectedAt ?? a.date))
    .slice(0, DIGEST_REJECT_WINDOW)
  const stats = buildRejectStats(rejects)
  const result = await run(`${DIGEST_PROMPT}\n\n${stats}`, opts)
  const text = truncateDigestText(result.text)
  if (!text) {
    throw new Error(
      'reject-digest rebuild produced no usable bullets (model response had no "- " line ' +
        'under the char cap) — refusing to overwrite the existing digest with an empty one'
    )
  }
  const dir = proposalsDir(argusHome)
  fs.mkdirSync(dir, { recursive: true })
  const fm = withFrontmatter('', {
    built_at: new Date().toISOString(),
    reject_count: String(totalRejects),
    ...(jobId != null ? { job: String(jobId) } : {})
  })
  fs.writeFileSync(path.join(dir, DIGEST_FILE), `${fm}${text}\n`)
}
