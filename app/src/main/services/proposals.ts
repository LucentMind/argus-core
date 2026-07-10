import fs from 'node:fs'
import path from 'node:path'
import { proposalsArchiveDir, proposalsDir, userSkillsDir } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { resolveSkills } from './agent/skillsResolver'
import { defaultAgentAccess } from '../../shared/agentAccess'
import { fmBlock, fmField, withFrontmatter } from './frontmatter'
import { PROPOSAL_TYPES, type ProposalRecord, type ProposalType } from '../../shared/proposals'

/** Target names: a skill dir name or a reference file name. Same shape as case slugs. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function refFileName(target: string): string {
  return target.endsWith('.md') ? target : `${target}.md`
}

export function writeProposal(
  argusHome: string,
  caseSlug: string,
  input: { type: string; target: string; title: string; content: string }
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
    out.push({
      file: ent.name,
      type,
      target,
      caseSlug: fmField(block.fm, 'case'),
      date: fmField(block.fm, 'date'),
      title: fmField(block.fm, 'title'),
      content: block.body,
      current: currentContent(argusHome, type, target)
    })
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
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
export function acceptProposal(argusHome: string, file: string): void {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  // defense-in-depth: p.target came from on-disk frontmatter (trusted only because
  // writeProposal validated it at write time) — re-validate before it joins a write path.
  if (!NAME_RE.test(p.target)) {
    throw new Error(`Invalid proposal target: ${JSON.stringify(p.target)}`)
  }
  if (p.type === 'skill-new' || p.type === 'skill-edit') {
    const dest = path.join(userSkillsDir(argusHome), p.target)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), p.content)
  } else {
    // reference-edit + recipe land in the references dir; accepting = human curation
    const dir = sharedReferencesDir(argusHome)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, refFileName(p.target)),
      withFrontmatter(p.content, { trust_tier: 'team-knowledge' })
    )
  }
  archive(argusHome, file, 'accepted')
}

export function rejectProposal(argusHome: string, file: string): void {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  archive(argusHome, p.file, 'rejected')
}
