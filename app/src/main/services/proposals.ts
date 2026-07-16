import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { memoryDir, proposalsArchiveDir, proposalsDir, userSkillsDir } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { resolveSkills } from './agent/skillsResolver'
import { defaultAgentAccess } from '../../shared/agentAccess'
import { fmBlock, fmField, withFrontmatter } from './frontmatter'
import { PROPOSAL_TYPES, type ProposalRecord, type ProposalType } from '../../shared/proposals'
import { applyMemoryWrite } from './memory'
import { upsertCaseSummary } from './distill/summaries'
import type { CaseDistillSummary } from '../../shared/distill'

/** Target names: a skill dir name or a reference file name. Same shape as case slugs. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Frontmatter keys writeProposal already owns — extraFm may not shadow these. */
const RESERVED_FM = new Set(['type', 'target', 'case', 'date', 'title', 'status'])
const EXTRA_FM_KEY_RE = /^[a-z_]+$/

function refFileName(target: string): string {
  return target.endsWith('.md') ? target : `${target}.md`
}

export function writeProposal(
  argusHome: string,
  caseSlug: string,
  input: { type: string; target: string; title: string; content: string },
  extraFm?: Record<string, string>
): string {
  const type = input.type as ProposalType
  if (!PROPOSAL_TYPES.includes(type)) {
    throw new Error(
      `Invalid proposal type: ${JSON.stringify(input.type)} (expected ${PROPOSAL_TYPES.join('|')})`
    )
  }
  const target = input.target.trim()
  if (!NAME_RE.test(target)) {
    throw new Error(`Invalid proposal target: ${JSON.stringify(input.target)}`)
  }
  if (!input.content.trim()) throw new Error('write_proposal: content must not be empty')
  for (const [k, v] of Object.entries(extraFm ?? {})) {
    if (RESERVED_FM.has(k)) throw new Error(`writeProposal: extraFm key "${k}" is reserved`)
    if (!EXTRA_FM_KEY_RE.test(k)) throw new Error(`writeProposal: invalid extraFm key "${k}"`)
    if (/\r|\n/.test(v))
      throw new Error(`writeProposal: extraFm value for "${k}" must be single-line`)
  }
  const dir = proposalsDir(argusHome)
  fs.mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString()
  const stem = `${date.slice(0, 10)}-${caseSlug}-${target.replace(/\.md$/, '')}`
  let file = `${stem}.md`
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${stem}-${i}.md`
  const fm = [
    '---',
    `type: ${type}`,
    `target: ${target}`,
    `case: ${caseSlug}`,
    `date: ${date}`,
    `title: ${input.title.replace(/[\r\n]/g, ' ').trim() || target}`,
    'status: pending',
    ...Object.entries(extraFm ?? {}).map(([k, v]) => `${k}: ${v}`),
    '---',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(dir, file), fm + input.content)
  return file
}

function currentContent(argusHome: string, type: ProposalType, target: string): string | null {
  if (type === 'skill-new' || type === 'skill-edit') {
    // the tier winner is what the agent currently sees — diff against that
    const winner = resolveSkills(argusHome, defaultAgentAccess()).find((s) => s.name === target)
    if (!winner) return null
    try {
      return fs.readFileSync(path.join(winner.dir, 'SKILL.md'), 'utf8')
    } catch {
      return null
    }
  }
  if (type === 'memory-append') {
    // diff against the existing topic file so the reviewer sees what the lesson appends to
    const p = path.join(memoryDir(argusHome), `${target}.md`)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  if (type === 'case-summary') return null
  try {
    return fs.readFileSync(path.join(sharedReferencesDir(argusHome), refFileName(target)), 'utf8')
  } catch {
    return null
  }
}

export function listProposals(argusHome: string): ProposalRecord[] {
  const dir = proposalsDir(argusHome)
  if (!fs.existsSync(dir)) return []
  const out: ProposalRecord[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    const raw = fs.readFileSync(path.join(dir, ent.name), 'utf8')
    const block = fmBlock(raw)
    if (!block) continue
    const type = fmField(block.fm, 'type') as ProposalType
    if (!PROPOSAL_TYPES.includes(type)) continue
    const target = fmField(block.fm, 'target')
    const previouslyReviewed = fmField(block.fm, 'previously_reviewed') === 'true'
    const job = fmField(block.fm, 'job')
    out.push({
      file: ent.name,
      type,
      target,
      caseSlug: fmField(block.fm, 'case'),
      date: fmField(block.fm, 'date'),
      title: fmField(block.fm, 'title'),
      content: block.body,
      current: currentContent(argusHome, type, target),
      ...(previouslyReviewed ? { previouslyReviewed: true } : {}),
      ...(job ? { jobId: job } : {})
    })
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
}

/** Type/target/title/status of every archived (accepted or rejected) proposal, across all cases. */
export function listArchivedProposals(argusHome: string): {
  type: string
  target: string
  caseSlug: string
  title: string
  status: 'accepted' | 'rejected'
}[] {
  const dir = proposalsArchiveDir(argusHome)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => {
      const block = fmBlock(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!block) return []
      const status = fmField(block.fm, 'status')
      if (status !== 'accepted' && status !== 'rejected') return []
      return [
        {
          type: fmField(block.fm, 'type'),
          target: fmField(block.fm, 'target'),
          caseSlug: fmField(block.fm, 'case'),
          title: fmField(block.fm, 'title'),
          status
        }
      ]
    })
}

/** Delete a pending proposal outright — used by supersede flows; the file is NOT archived. */
export function removePendingProposal(argusHome: string, file: string): void {
  const p = path.join(proposalsDir(argusHome), path.basename(file))
  if (fs.existsSync(p)) fs.rmSync(p)
}

function archive(argusHome: string, file: string, status: 'accepted' | 'rejected'): void {
  const src = path.join(proposalsDir(argusHome), file)
  const dir = proposalsArchiveDir(argusHome)
  fs.mkdirSync(dir, { recursive: true })
  const updated = fs.readFileSync(src, 'utf8').replace(/^status: pending\r?$/m, `status: ${status}`)
  fs.writeFileSync(path.join(dir, file), updated)
  fs.rmSync(src)
}

/** Apply to the USER tier (a proposal against a bundled asset shadows it — §1.4), then archive. */
export function acceptProposal(
  argusHome: string,
  file: string,
  opts: { db?: DatabaseSync; editedContent?: string } = {}
): void {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  // defense-in-depth: p.target came from on-disk frontmatter (trusted only because
  // writeProposal validated it at write time) — re-validate before it joins a write path.
  if (!NAME_RE.test(p.target)) {
    throw new Error(`Invalid proposal target: ${JSON.stringify(p.target)}`)
  }
  const body = opts.editedContent?.trim() ? opts.editedContent : p.content
  const raw = fs.readFileSync(path.join(proposalsDir(argusHome), file), 'utf8')
  const fm = fmBlock(raw)?.fm ?? ''

  if (p.type === 'memory-append') {
    const indexEntry = fmField(fm, 'index_entry') || undefined
    // Index-cap errors from applyMemoryWrite propagate to the caller — the renderer
    // surfaces them in the accept banner instead of silently discarding the write.
    applyMemoryWrite(argusHome, p.caseSlug, { topic: p.target, content: body, indexEntry })
  } else if (p.type === 'case-summary') {
    if (!opts.db) throw new Error('case-summary accept requires db')
    const sj = fmField(fm, 'summary_json')
    if (!sj) throw new Error('case-summary proposal missing summary_json frontmatter')
    const summary = JSON.parse(sj) as CaseDistillSummary
    const resolution = fmField(fm, 'resolution') || 'solved'
    upsertCaseSummary(opts.db, argusHome, p.target, summary, resolution, body)
  } else if (p.type === 'skill-new' || p.type === 'skill-edit') {
    const dest = path.join(userSkillsDir(argusHome), p.target)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), body)
  } else {
    // reference-edit + recipe land in the references dir; accepting = human curation
    const dir = sharedReferencesDir(argusHome)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, refFileName(p.target)),
      withFrontmatter(body, { trust_tier: 'team-knowledge' })
    )
  }
  archive(argusHome, file, 'accepted')
}

export function rejectProposal(argusHome: string, file: string): void {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  archive(argusHome, p.file, 'rejected')
}
