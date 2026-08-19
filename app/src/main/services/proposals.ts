import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { proposalsArchiveDir, proposalsDir, userSkillsDir } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { resolveSkills, isBundledSkillName, bundledSkillError } from './agent/skillsResolver'
import {
  refTier,
  isHandOwnedReferenceTier,
  assertHandOwnedReferenceTier
} from './refSync/refFrontmatter'
import { defaultAgentAccess } from '../../shared/agentAccess'
import { ASSET_NAME_RE, validateSkill, hasErrors } from '../../shared/assetValidation'
import {
  assetPathError,
  assetSetError,
  isExecutableAsset,
  SKILL_TEMP_PREFIXES,
  type SkillAssetInput
} from '../../shared/skillAssets'
import { recordAssetReviews } from './skillAssetReviews'
import { fmBlock, fmField, withFrontmatter } from '../../shared/frontmatter'
import { mergeAuthorship, stampAuthorship, type Identity } from '../../shared/authorship'
import {
  ACCEPTED_CONTENT_DELIMITER,
  PROPOSAL_TYPES,
  REJECT_REASON_TAGS,
  type AcceptedTarget,
  type ProposalCounts,
  type ProposalFile,
  type ProposalRecord,
  type ProposalType,
  type RejectReason
} from '../../shared/proposals'
import type { TrustTier } from '../../shared/trustTiers'
import { upsertCaseSummary } from './distill/summaries'
import type { CaseDistillSummary } from '../../shared/distill'

/**
 * Every producer of proposal-set changes routes through this module (agent
 * write_proposal, distill staging, accept/reject/supersede), so one hook here
 * is the single announcement point. index.ts wires it to a renderer broadcast.
 */
let notifyChanged: () => void = () => {}
export function setProposalsChangedNotifier(cb: () => void): void {
  notifyChanged = cb
}

let batchDepth = 0
let batchDirty = false
function announceChanged(): void {
  if (batchDepth > 0) {
    batchDirty = true
    return
  }
  notifyChanged()
}

/**
 * Coalesce every proposal-set change inside fn into at most one announcement,
 * fired when the outermost batch ends — even if fn throws after some writes
 * already landed on disk. Distill staging writes one file per staged item;
 * without this each write broadcasts (and recounts) separately.
 */
export function batchProposalChanges<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false
      notifyChanged()
    }
  }
}

/**
 * Counting runs on every proposals:changed broadcast, so it must stay
 * frontmatter-cheap — no current-content resolution (resolveSkills scans the
 * skill tiers per skill proposal, which made counting O(N²) during staging).
 */
export function proposalCounts(argusHome: string): ProposalCounts {
  const byType: ProposalCounts['byType'] = {}
  let pendingCount = 0
  for (const p of pendingProposalFiles(argusHome)) {
    pendingCount++
    byType[p.type] = (byType[p.type] ?? 0) + 1
  }
  return { pendingCount, byType }
}

/** Frontmatter keys writeProposal already owns — extraFm may not shadow these. */
const RESERVED_FM = new Set(['type', 'target', 'case', 'date', 'title', 'status'])
const EXTRA_FM_KEY_RE = /^[a-z_]+$/

function refFileName(target: string): string {
  return target.endsWith('.md') ? target : `${target}.md`
}

/** Target names: a skill dir name or a reference file name. Same shape as case slugs. */
export function isValidProposalTarget(target: string): boolean {
  return ASSET_NAME_RE.test(target)
}

export function writeProposal(
  argusHome: string,
  caseSlug: string,
  input: {
    type: string
    target: string
    title: string
    content: string
    /** Sibling files for skill-new/skill-edit. Non-empty makes the proposal directory-shaped. */
    files?: SkillAssetInput[]
  },
  extraFm?: Record<string, string>
): string {
  const type = input.type as ProposalType
  if (!PROPOSAL_TYPES.includes(type)) {
    throw new Error(
      `Invalid proposal type: ${JSON.stringify(input.type)} (expected ${PROPOSAL_TYPES.join('|')})`
    )
  }
  const target = input.target.trim()
  if (!isValidProposalTarget(target)) {
    throw new Error(`Invalid proposal target: ${JSON.stringify(input.target)}`)
  }
  if (!input.content.trim()) throw new Error('write_proposal: content must not be empty')
  for (const [k, v] of Object.entries(extraFm ?? {})) {
    if (RESERVED_FM.has(k)) throw new Error(`writeProposal: extraFm key "${k}" is reserved`)
    if (!EXTRA_FM_KEY_RE.test(k)) throw new Error(`writeProposal: invalid extraFm key "${k}"`)
    if (/\r|\n/.test(v))
      throw new Error(`writeProposal: extraFm value for "${k}" must be single-line`)
  }
  const files = input.files ?? []
  if (files.length > 0) {
    if (type !== 'skill-new' && type !== 'skill-edit') {
      throw new Error(
        `write_proposal: files are only valid for skill-new and skill-edit (got ${type})`
      )
    }
    const bad = assetSetError(files)
    // Thrown BEFORE any mkdir: a rejected proposal must leave no directory behind for the
    // inbox to scan.
    if (bad) throw new Error(`write_proposal: ${bad}`)
  }

  const dir = proposalsDir(argusHome)
  fs.mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString()
  // Only the DIRECTORY shape needs the repeated strip. `proposalBodyPath` misroutes a
  // directory whose name ends in `.md`, but a FLAT proposal named `…-a.md.md` is read
  // correctly — so the flat branch keeps the historical single strip and its file names stay
  // byte-identical to what this function produced before multi-file proposals existed.
  const prefix = `${date.slice(0, 10)}-${caseSlug}-`
  const stem =
    files.length > 0
      ? `${prefix}${target.replace(/(\.md)+$/, '')}`
      : `${prefix}${target.replace(/\.md$/, '')}`
  const suffix = files.length > 0 ? '' : '.md'
  let file = `${stem}${suffix}`
  // One loop for both shapes. Writing a directory (suffix ''): the second existsSync probes
  // `${file}.md` so a new directory can't pick a name that shadows an existing flat file's
  // name plus `.md`. Writing a flat file (suffix '.md'): that same second probe checks
  // `${stem}.md.md`, which is inert — the hardening assertion below guarantees no directory
  // can end in `.md`, so no real directory can ever match it. Kept as one loop rather than
  // branching so the two shapes can't drift apart independently.
  for (
    let i = 2;
    fs.existsSync(path.join(dir, file)) || fs.existsSync(path.join(dir, `${file}.md`));
    i++
  ) {
    file = `${stem}-${i}${suffix}`
  }
  // Belt and braces behind the `(\.md)+` strip above: `proposalBodyPath` distinguishes the
  // two shapes by this suffix alone, so a directory ending in `.md` would be read as a file
  // and throw EISDIR out of every listing. Never reachable via the stem rule — asserted
  // because the blast radius is the entire proposals inbox.
  if (files.length > 0 && file.endsWith('.md')) {
    throw new Error(`writeProposal: refusing a directory-shaped proposal named "${file}"`)
  }
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
  if (files.length === 0) {
    fs.writeFileSync(path.join(dir, file), fm + input.content)
  } else {
    const root = path.join(dir, file)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'SKILL.md'), fm + input.content)
    for (const f of files) {
      const abs = path.join(root, f.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content)
    }
  }
  announceChanged()
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
  if (type === 'case-summary') return null
  try {
    return fs.readFileSync(path.join(sharedReferencesDir(argusHome), refFileName(target)), 'utf8')
  } catch {
    return null
  }
}

/** Would accepting this proposal create a NEW shadow of, or overwrite, a non-hand-owned
 *  asset? Mirrors the guards `acceptProposal` itself runs, so the UI can disable Accept
 *  before the user even tries. */
function targetLocked(argusHome: string, type: ProposalType, target: string): boolean {
  if (type === 'skill-new' || type === 'skill-edit') {
    const destFile = path.join(userSkillsDir(argusHome), target, 'SKILL.md')
    return !fs.existsSync(destFile) && isBundledSkillName(argusHome, target)
  }
  if (type === 'reference-edit') {
    const destFile = path.join(sharedReferencesDir(argusHome), refFileName(target))
    if (!fs.existsSync(destFile)) return false
    return !isHandOwnedReferenceTier(refTier(fs.readFileSync(destFile, 'utf8')))
  }
  return false
}

/**
 * A proposal's SHAPE, decided from its name alone and in exactly one place.
 *
 * Four call sites used to make this judgement independently (body path, sibling walk,
 * directory scan, archive), agreeing only because `writeProposal` guarantees
 * "directory ⟺ no `.md` suffix". That guarantee covers the in-app writer, not the
 * externally seeded proposals `proposalsWatch.ts` exists to support — so the agreement was
 * a coincidence of the writer, not a property of the readers. One definition, no drift.
 */
function isFlatProposalName(file: string): boolean {
  return file.endsWith('.md')
}

/**
 * The `.md` holding a proposal's frontmatter and body: the flat file itself, or the
 * directory's SKILL.md. A proposal's `file` key is the flat file name or the directory
 * name, so every caller that used to `path.join(dir, file)` goes through here instead.
 */
export function proposalBodyPath(dir: string, file: string): string {
  return isFlatProposalName(file) ? path.join(dir, file) : path.join(dir, file, 'SKILL.md')
}

/**
 * Every proposal entry in `dir`, in either shape — flat `<stem>.md`, or a directory carrying
 * SKILL.md plus siblings.
 *
 * This is the ONLY readdir over a proposals directory. Nothing else may filter entries on
 * `.md`: `listArchivedProposals` used to do exactly that, which would have made a
 * directory-shaped archived proposal vanish from the archive listing, from the cross-case
 * prior-reject map and from the reject digest — with no error anywhere. See spec §1.
 *
 * `distill/evalExport.ts`'s `scanJobStamped` is the second enforcement site for this
 * invariant — it consumes this scanner too, so a future reader adding a third proposals
 * reader knows to route through here rather than rolling its own readdir.
 */
/** Names already warned about: this scanner runs on every count and every list, so an
 *  unfixed on-disk mistake would otherwise print on every proposals:changed broadcast. */
const warnedMdDirs = new Set<string>()

export function scanProposalDir(dir: string): { file: string; raw: string }[] {
  if (!fs.existsSync(dir)) return []
  const out: { file: string; raw: string }[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.md')) {
      out.push({ file: ent.name, raw: fs.readFileSync(path.join(dir, ent.name), 'utf8') })
      continue
    }
    if (!ent.isDirectory()) continue
    // A DIRECTORY named `…​.md` is unresolvable: `isFlatProposalName` judges shape from the name
    // alone, so `proposalBodyPath` would hand every caller the directory itself and accept and
    // reject would both throw EISDIR reading it — the entry would be listed in the inbox and be
    // neither acceptable nor rejectable, wedged until someone deletes it by hand. `writeProposal`
    // cannot produce this, but an externally seeded proposal (proposalsWatch.ts) can, so refuse
    // it here rather than letting the shape question be answered twice.
    if (isFlatProposalName(ent.name)) {
      if (!warnedMdDirs.has(ent.name)) {
        warnedMdDirs.add(ent.name)
        console.warn(
          `[proposals] ignoring a directory-shaped proposal whose name ends in .md: ${ent.name}`
        )
      }
      continue
    }
    const body = path.join(dir, ent.name, 'SKILL.md')
    if (!fs.existsSync(body)) continue
    out.push({ file: ent.name, raw: fs.readFileSync(body, 'utf8') })
  }
  return out
}

/** Every well-formed pending file (valid frontmatter block + known type), frontmatter only. */
function pendingProposalFiles(
  argusHome: string
): { file: string; type: ProposalType; fm: string; body: string }[] {
  const out: { file: string; type: ProposalType; fm: string; body: string }[] = []
  for (const { file, raw } of scanProposalDir(proposalsDir(argusHome))) {
    const block = fmBlock(raw)
    if (!block) continue
    const type = fmField(block.fm, 'type') as ProposalType
    if (!PROPOSAL_TYPES.includes(type)) continue
    out.push({ file, type, fm: block.fm, body: block.body })
  }
  return out
}

/** Per-file `current`: the installed user-tier copy of the same relative path, or null. */
function proposalFileRecords(argusHome: string, file: string, target: string): ProposalFile[] {
  const skillRoot = path.join(userSkillsDir(argusHome), target)
  return proposalAssets(argusHome, file).map((a) => {
    const currentPath = path.join(skillRoot, a.path)
    let current: string | null = null
    try {
      current = fs.readFileSync(currentPath, 'utf8')
    } catch {
      current = null // new file, or no installed skill — "not there" is an answer
    }
    return {
      path: a.path,
      content: a.content,
      current,
      exec: isExecutableAsset(a.path, a.content),
      ...(a.unreadable ? { unreadable: true } : {})
    }
  })
}

export function listProposals(argusHome: string): ProposalRecord[] {
  return pendingProposalFiles(argusHome)
    .map(({ file, type, fm, body }) => {
      const target = fmField(fm, 'target')
      const previouslyReviewed = fmField(fm, 'previously_reviewed') === 'true'
      const job = fmField(fm, 'job')
      const basis = fmField(fm, 'basis')
      const priorRejectCase = fmField(fm, 'prior_reject_case')
      const priorRejectTag = fmField(fm, 'prior_reject_tag')
      const priorRejectNote = fmField(fm, 'prior_reject_note')
      return {
        file,
        type,
        target,
        caseSlug: fmField(fm, 'case'),
        date: fmField(fm, 'date'),
        title: fmField(fm, 'title'),
        content: body,
        current: currentContent(argusHome, type, target),
        ...(targetLocked(argusHome, type, target) ? { locked: true } : {}),
        ...(previouslyReviewed ? { previouslyReviewed: true } : {}),
        ...(job ? { jobId: job } : {}),
        ...(basis ? { basis } : {}),
        ...(() => {
          const files = proposalFileRecords(argusHome, file, target)
          return files.length > 0 ? { files } : {}
        })(),
        ...(priorRejectCase
          ? {
              priorReject: {
                caseSlug: priorRejectCase,
                ...(priorRejectTag ? { tag: priorRejectTag } : {}),
                ...(priorRejectNote ? { note: priorRejectNote } : {})
              }
            }
          : {})
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}

/** Type/target/title/status of every archived (accepted or rejected) proposal, across all cases. */
export function listArchivedProposals(argusHome: string): {
  type: string
  target: string
  caseSlug: string
  title: string
  status: 'accepted' | 'rejected'
  date: string
  rejectReason?: string
  rejectNote?: string
  /** When the REJECT happened (stamped by rejectProposal), distinct from `date` (proposal
   *  CREATION time, stamped once by writeProposal and never touched again). Absent on rows
   *  archived before this field existed — callers that need recency must fall back to `date`. */
  rejectedAt?: string
}[] {
  return scanProposalDir(proposalsArchiveDir(argusHome)).flatMap(({ raw }) => {
    const block = fmBlock(raw)
    if (!block) return []
    const status = fmField(block.fm, 'status')
    if (status !== 'accepted' && status !== 'rejected') return []
    const rejectReason = fmField(block.fm, 'reject_reason')
    const rejectNote = fmField(block.fm, 'reject_note')
    const rejectedAt = fmField(block.fm, 'rejected_at')
    return [
      {
        type: fmField(block.fm, 'type'),
        target: fmField(block.fm, 'target'),
        caseSlug: fmField(block.fm, 'case'),
        title: fmField(block.fm, 'title'),
        date: fmField(block.fm, 'date'),
        status,
        ...(rejectReason ? { rejectReason } : {}),
        ...(rejectNote ? { rejectNote } : {}),
        ...(rejectedAt ? { rejectedAt } : {})
      }
    ]
  })
}

/** Delete a pending proposal outright — used by supersede flows; it is NOT archived. */
export function removePendingProposal(argusHome: string, file: string): void {
  const p = path.join(proposalsDir(argusHome), path.basename(file))
  if (fs.existsSync(p)) {
    // recursive: a directory-shaped proposal (spec §1) is a tree, and a bare rmSync throws
    // EISDIR on it.
    fs.rmSync(p, { recursive: true, force: true })
    announceChanged()
  }
}

function archive(
  argusHome: string,
  file: string,
  status: 'accepted' | 'rejected',
  extraFm: Record<string, string> = {},
  /** Appended verbatim after the frontmatter/status rewrite — used to preserve the original
   *  draft body while also recording the human's edited accept text (see acceptProposal). */
  appendix?: string,
  /** Reviewer-edited sibling files, relPath → content, archived under `edited/<relPath>` beside
   *  the original. The originals stay verbatim: accept-time human edits are the highest-signal
   *  training data the system produces, and overwriting them in place would lose the pair. */
  editedFiles?: Record<string, string>
): void {
  const srcDir = proposalsDir(argusHome)
  const dstDir = proposalsArchiveDir(argusHome)
  fs.mkdirSync(dstDir, { recursive: true })
  const src = path.join(srcDir, file)
  const dst = path.join(dstDir, file)
  const isDir = fs.statSync(src).isDirectory()
  const extra = Object.entries({
    ...extraFm,
    ...(editedFiles && Object.keys(editedFiles).length > 0
      ? { edited_files: Object.keys(editedFiles).sort().join(',') }
      : {})
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const bodySrc = proposalBodyPath(srcDir, file)
  const updated = fs
    .readFileSync(bodySrc, 'utf8')
    .replace(/^status: pending\r?$/m, `status: ${status}${extra ? `\n${extra}` : ''}`)
  if (isDir) fs.rmSync(dst, { recursive: true, force: true })
  try {
    if (isDir) fs.cpSync(src, dst, { recursive: true })
    fs.writeFileSync(proposalBodyPath(dstDir, file), updated + (appendix ?? ''))
    for (const [rel, content] of Object.entries(editedFiles ?? {})) {
      // Defense in depth: the accept path validates these, but `archive` joins them into a path
      // and this file's convention is that a write path re-checks its own inputs.
      const bad = assetPathError(rel)
      if (bad) throw new Error(`archive: refusing edited file — ${bad}`)
      const abs = path.join(dst, 'edited', rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
  } catch (e) {
    // Guarded on isDir so the flat path throws exactly as it does today. For a directory, a
    // half-built archive is worse than none: with no rewritten SKILL.md `scanProposalDir` skips
    // it, so the record reads as absent rather than broken. `src` is untouched — retry is clean.
    if (isDir) fs.rmSync(dst, { recursive: true, force: true })
    throw e
  }
  fs.rmSync(src, { recursive: true, force: true })
}

/**
 * One sibling file read off a skill-shaped directory. `unreadable` marks a file that is present
 * but could not be read: it must be SURFACED, never dropped — a silently dropped file would be
 * accepted-but-missing, and nothing downstream would notice (spec §10).
 */
interface ProposalAsset {
  path: string
  content: string
  unreadable?: boolean
}

/**
 * Every file under `root` except SKILL.md, as `/`-joined relative paths with contents, sorted.
 *
 * ONE walker serves both sides of an accept — the proposal directory and the installed skill
 * directory — because they differ only in which root they are handed. (`fileListing` in
 * skillsResolver.ts stays as it is: it returns paths without contents and serves HiveMind's
 * divergence compare, which is outside this increment.)
 */
function walkSkillFiles(root: string): ProposalAsset[] {
  if (!fs.existsSync(root)) return []
  const out: ProposalAsset[] = []
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(r)
        continue
      }
      if (r === 'SKILL.md') continue
      try {
        out.push({ path: r, content: fs.readFileSync(path.join(root, r), 'utf8') })
      } catch {
        out.push({ path: r, content: '', unreadable: true })
      }
    }
  }
  walk('')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Sibling files carried by a directory-shaped proposal; empty for the flat shape. */
function proposalAssets(argusHome: string, file: string): ProposalAsset[] {
  return isFlatProposalName(file) ? [] : walkSkillFiles(path.join(proposalsDir(argusHome), file))
}

/**
 * Write a complete skill directory, or leave the previous one untouched.
 *
 * Staged then swapped in two renames because Windows cannot rename over an existing directory,
 * and because a half-written skill directory is a state no reader in this codebase expects:
 * `scanTier` would list it, the prompt index would advertise it, and the missing half would
 * surface as a skill that silently does nothing.
 */
function writeSkillDirAtomically(dest: string, files: Map<string, string>): void {
  const parent = path.dirname(dest)
  const base = path.basename(dest)
  const token = crypto.randomUUID().slice(0, 8)
  // Prefixes come from SKILL_TEMP_PREFIXES (shared/skillAssets.ts), the same definition
  // `scanTier` skips on. Hard-coding the strings here would let the two drift and silently
  // reopen the leak where a mid-accept skills list advertises a staging directory.
  const [stagingPrefix, trashPrefix] = SKILL_TEMP_PREFIXES
  const staging = path.join(parent, `${stagingPrefix}${base}-${token}`)
  const trash = path.join(parent, `${trashPrefix}${base}-${token}`)
  fs.mkdirSync(parent, { recursive: true })
  fs.rmSync(staging, { recursive: true, force: true })
  const had = fs.existsSync(dest)
  try {
    // Carry-forward by COPY, not by re-writing strings: cpSync preserves bytes and mode, where a
    // read-as-utf8/write-as-string round trip corrupts a binary sibling (a PNG or zip that
    // arrived via skills import or a HiveMind pull), zero-fills an unreadable one, and drops the
    // +x bit off a script. The proposal's own files are overlaid on top, so they still win.
    if (had) fs.cpSync(dest, staging, { recursive: true })
    for (const [rel, content] of files) {
      const abs = path.join(staging, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    if (had) fs.renameSync(dest, trash)
    fs.renameSync(staging, dest)
  } catch (e) {
    // Put the original back before rethrowing: a failed accept must never leave the user with no
    // skill where they had a working one.
    if (had && !fs.existsSync(dest) && fs.existsSync(trash)) fs.renameSync(trash, dest)
    fs.rmSync(staging, { recursive: true, force: true })
    throw e
  }
  // Best-effort: the swap already succeeded. A failure here (Windows EBUSY on a handle held
  // against the previous copy is routine) must not turn a completed install into a thrown accept
  // with no review rows and an un-archived proposal. `scanTier` skips this prefix, so a leftover
  // is invisible rather than harmful.
  try {
    fs.rmSync(trash, { recursive: true, force: true })
  } catch {
    /* leftover trash is inert */
  }
}

/** Apply to the USER tier (a proposal against a bundled asset shadows it — §1.4), then archive. */
export function acceptProposal(
  argusHome: string,
  file: string,
  opts: {
    db?: DatabaseSync
    editedContent?: string
    /** Reviewer-edited sibling files, relPath → content. `SKILL.md` is not a member — the body
     *  keeps using `editedContent`. */
    editedFiles?: Record<string, string>
    /** Who is accepting; null when this machine has no git identity (no stamp is written). */
    identity?: Identity | null
    /** Injectable for deterministic tests. */
    now?: Date
  } = {}
): AcceptedTarget {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  // defense-in-depth: p.target came from on-disk frontmatter (trusted only because
  // writeProposal validated it at write time) — re-validate before it joins a write path.
  if (!ASSET_NAME_RE.test(p.target)) {
    throw new Error(`Invalid proposal target: ${JSON.stringify(p.target)}`)
  }
  const body = opts.editedContent?.trim() ? opts.editedContent : p.content
  const stamp = (content: string): string =>
    stampAuthorship(content, {
      identity: opts.identity ?? null,
      origin: 'proposal',
      now: opts.now ?? new Date()
    })
  // proposalBodyPath, not a bare join: a directory-shaped proposal keeps its frontmatter in
  // SKILL.md, and reading the directory itself throws EISDIR before any branch runs.
  const raw = fs.readFileSync(proposalBodyPath(proposalsDir(argusHome), file), 'utf8')
  const fm = fmBlock(raw)?.fm ?? ''

  let accepted: AcceptedTarget
  if (p.type === 'case-summary') {
    if (!opts.db) throw new Error('case-summary accept requires db')
    const sj = fmField(fm, 'summary_json')
    if (!sj) throw new Error('case-summary proposal missing summary_json frontmatter')
    const summary = JSON.parse(sj) as CaseDistillSummary
    const resolution = fmField(fm, 'resolution') || 'solved'
    upsertCaseSummary(opts.db, argusHome, p.target, summary, resolution, body)
    accepted = { kind: 'case-summary', name: p.target }
  } else if (p.type === 'skill-new' || p.type === 'skill-edit') {
    // Agents are never asked for frontmatter `name:` (write_proposal's tool description only
    // says "provide the FULL proposed file content") and nothing downstream reads it —
    // resolveSkills keys skills by directory name. The editor's folder-equals-name invariant
    // is real (validateSkill enforces it), but the accept path is the wrong place to make an
    // agent responsible for it: stamp the target in before validating, so a proposal with no
    // `name:` (the common case) or a wrong one still lands correctly instead of being rejected.
    const named = withFrontmatter(body, { name: p.target })
    const dest = path.join(userSkillsDir(argusHome), p.target)
    const destFile = path.join(dest, 'SKILL.md')
    // A skill-edit lands on a skill that already exists and may already have an author. The
    // file on disk owns author/origin/contributors — accepting an agent's edit to someone
    // else's skill makes the accepter a contributor, not the author. (Spec §7 reads the other
    // way; the human resolved that contradiction in favour of the disk on 2026-07-30.)
    const existing = fs.existsSync(destFile) ? fs.readFileSync(destFile, 'utf8') : null
    if (existing === null && isBundledSkillName(argusHome, p.target)) {
      throw bundledSkillError(p.target)
    }
    const stamped = stamp(mergeAuthorship(named, existing))
    // An empty description makes the skill un-triggerable and nothing downstream complains,
    // so the accept path is the last place to catch it. Same gate the in-app editor uses —
    // run on the bytes actually written, so merge+stamp cannot slip past it.
    const issues = validateSkill({ name: p.target, content: stamped })
    if (hasErrors(issues)) {
      throw new Error(
        `Cannot accept "${p.target}": ${issues.find((i) => i.severity === 'error')!.message}`
      )
    }
    const assets = proposalAssets(argusHome, file)
    // A file we could not read must abort the accept, not land as an empty file: the throw
    // happens before `writeSkillDirAtomically`, so the installed skill is untouched (spec §10).
    const unreadable = assets.filter((a) => a.unreadable).map((a) => a.path)
    if (unreadable.length > 0) {
      throw new Error(`Cannot accept "${p.target}": unreadable file(s): ${unreadable.join(', ')}`)
    }
    const edits = opts.editedFiles ?? {}
    const unknown = Object.keys(edits).filter((rel) => !assets.some((a) => a.path === rel))
    if (unknown.length > 0) {
      throw new Error(
        `Cannot accept "${p.target}": edited file not in the proposal: ${unknown.join(', ')}`
      )
    }
    const finalAssets = assets.map((a) => ({
      path: a.path,
      content: Object.prototype.hasOwnProperty.call(edits, a.path) ? edits[a.path] : a.content
    }))
    // Re-run the write-time rules on the bytes actually about to land: `editedFiles` arrives
    // over IPC, and the on-disk proposal was validated by a past write, not this one.
    const assetIssue = assetSetError(finalAssets)
    if (assetIssue) throw new Error(`Cannot accept "${p.target}": ${assetIssue}`)

    // Only the proposal's own files plus SKILL.md. Siblings the proposal did not mention are
    // carried forward by `writeSkillDirAtomically`, which seeds its staging tree by COPYING the
    // installed directory — bytes and mode intact, for BOTH skill types. Nothing is ever removed:
    // deletion is a human editor action, which no proposal type may cause.
    const files = new Map<string, string>()
    for (const f of finalAssets) files.set(f.path, f.content)
    files.set('SKILL.md', stamped)

    // Checked BEFORE the write: a throw between the skill landing on disk and its review rows
    // being recorded is exactly the split state the staging/swap exists to prevent.
    const executables = finalAssets.filter((f) => isExecutableAsset(f.path, f.content))
    if (executables.length > 0 && !opts.db) {
      throw new Error('accepting a skill with executable files requires db')
    }
    writeSkillDirAtomically(dest, files)

    // The `opts.db` test is the guard above restated so the type narrows here; it can never be
    // the reason this block is skipped.
    if (executables.length > 0 && opts.db) {
      recordAssetReviews(
        opts.db,
        p.target,
        executables.map((f) => ({ relPath: f.path, content: f.content })),
        {
          origin: 'proposal',
          reviewedBy: opts.identity?.name ?? null,
          now: opts.now ?? new Date()
        }
      )
    }
    accepted = { kind: 'skill', name: p.target }
  } else {
    // reference-edit lands in the references dir; accepting = human curation
    const dir = sharedReferencesDir(argusHome)
    const destFile = path.join(dir, refFileName(p.target))
    // as above: an edit to an existing reference keeps its author, and the accepter joins the
    // contributor trail rather than replacing it
    const existing = fs.existsSync(destFile) ? fs.readFileSync(destFile, 'utf8') : null
    if (existing !== null) {
      assertHandOwnedReferenceTier(refTier(existing), refFileName(p.target))
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      destFile,
      stamp(
        mergeAuthorship(
          withFrontmatter(body, { trust_tier: 'team-knowledge' satisfies TrustTier }),
          existing
        )
      )
    )
    accepted = { kind: 'reference', name: refFileName(p.target) }
  }
  // "Edited" means the human's accept text differs from the agent's draft — an accept whose
  // editedContent merely round-trips the draft (e.g. the UI always sends the textarea value)
  // must not gain an `edited: true` stamp it doesn't deserve, and the archived byte content
  // must not diverge from an unedited accept's for change-detection tooling and existing tests.
  const edited =
    Boolean(opts.editedContent?.trim()) && opts.editedContent!.trim() !== p.content.trim()
  archive(
    argusHome,
    file,
    'accepted',
    edited ? { edited: 'true' } : {},
    // The leading '\n' is spacing (blank line before the delimiter comment); the delimiter
    // itself — the load-bearing bytes evalExport.ts's lastIndexOf split matches on — comes
    // verbatim from the shared constant so the two sides can never drift apart.
    edited ? `\n${ACCEPTED_CONTENT_DELIMITER}${body}` : undefined,
    opts.editedFiles
  )
  announceChanged()
  return accepted
}

export function rejectProposal(
  argusHome: string,
  file: string,
  reason?: RejectReason,
  /** Injectable for deterministic tests (e.g. proving a recency-ordered tie-break). */
  now: Date = new Date()
): void {
  const p = listProposals(argusHome).find((x) => x.file === file)
  if (!p) throw new Error(`Unknown proposal: ${file}`)
  // Distinct from the proposal's `date` (creation time, stamped once by writeProposal): this is
  // when the REJECTION happened, which is what a "most recent rejection wins" tie-break needs.
  const extra: Record<string, string> = { rejected_at: now.toISOString() }
  if (reason) {
    // IPC arguments are untyped at runtime — validate before the tag joins frontmatter.
    if (!REJECT_REASON_TAGS.includes(reason.tag)) {
      throw new Error(`Invalid reject reason: ${JSON.stringify(reason.tag)}`)
    }
    extra.reject_reason = reason.tag
    const note = (reason.note ?? '')
      .split(/\r\n|\r|\n/)
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 200)
    if (note) extra.reject_note = note
  }
  archive(argusHome, p.file, 'rejected', extra)
  announceChanged()
}
