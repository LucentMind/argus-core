import fs from 'node:fs'
import path from 'node:path'
import { REFERENCES_INDEX } from '../../../shared/referenceSync'
import { refBody } from './refFrontmatter'

/**
 * Every *.md under the references dir, recursively, as a relPath with forward slashes and
 * excluding the generated INDEX.md router.
 *
 * One definition on purpose. This walk used to live only in observability/usage.ts, while
 * referenceStatuses, generateReferencesIndex and searchReferences each did their own FLAT
 * readdir — so a nested reference (seedReferenceTree copies subtrees, deliberately recursive)
 * got a usage row but no Library row, no index line and no search hit.
 */
export function listReferenceFiles(refsDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // existsSync is not enough: it passes for a plain FILE at refsDir (ENOTDIR), and for a
      // directory that then fails to scandir (EPERM, or an ENOENT race with an external
      // process). This walk feeds buildReferenceIndex, which runs INLINE in the CaseSession
      // constructor — a throw here would abort session creation rather than degrade to "no
      // references". An unreadable directory contributes nothing; it never fails the caller.
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.md')) {
        // Compare the BASENAME, not the relPath: a pack that ships its own sub-router at
        // references/protocols/INDEX.md is a generated file too, and shared/assetEditable.ts
        // only recognizes the top-level one — so a relPath compare would list it as an ordinary
        // reference and offer it as editable.
        if (e.name !== REFERENCES_INDEX) {
          out.push(path.relative(refsDir, p).split(path.sep).join('/'))
        }
      }
    }
  }
  walk(refsDir)
  return out.sort()
}

/** First non-empty, non-heading body line — the one-line summary both index builders show. */
export function referenceSummary(raw: string): string {
  return (
    refBody(raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? ''
  )
}

/**
 * Resolve a reference relPath against the references root, refusing anything that lands
 * outside it (traversal, or an absolute path that ignores the root entirely).
 *
 * READ paths only. Writes and deletes keep the stricter basename guard REF_TARGET_RE, so
 * accepting a subdirectory here cannot widen what the app will overwrite or unlink.
 */
export function resolveReferencePath(refsDir: string, relPath: string): string {
  const root = path.resolve(refsDir)
  const abs = path.resolve(root, relPath)
  // NTFS is case-insensitive; a raw compare would reject a valid path whose drive-letter
  // casing drifts. Same treatment agent/toolDetail.ts applies for the same reason.
  const cmpAbs = process.platform === 'win32' ? abs.toLowerCase() : abs
  const cmpRoot = process.platform === 'win32' ? root.toLowerCase() : root
  if (!cmpAbs.startsWith(cmpRoot + path.sep)) {
    throw new Error(`invalid reference name: ${relPath}`)
  }
  return abs
}
