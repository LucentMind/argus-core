import { frontmatterOf, parseDescription, parseRoles, hasRolesKey } from './skillFrontmatter'
import { MODES } from './modes'
import { REF_TARGET_RE, REFERENCES_INDEX } from './referenceSync'

/**
 * Legal skill-directory / reference-target name. Originally `NAME_RE` in
 * main/services/proposals.ts, which now imports it from here — agent proposals and
 * hand-authored assets must pass the same name check.
 */
export const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  /** 1-indexed line in the file, when the issue can be located. */
  line?: number
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.values(MODES).map((m) => m.role))

/** 1-indexed line of the first line matching `key:` inside the frontmatter block. */
function lineOfKey(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}:`))
  return i === -1 ? undefined : i + 1
}

/** Text after the frontmatter fence; the whole file when there is no fence. */
function bodyOf(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? content.slice(m[0].length) : content
}

export function validateSkill(input: { name: string; content: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { name, content } = input

  if (!ASSET_NAME_RE.test(name)) {
    issues.push({ severity: 'error', message: `"${name}" is not a legal skill name.` })
  }

  const fm = frontmatterOf(content)
  if (fm === null) {
    issues.push({
      severity: 'error',
      message: 'Missing frontmatter — the file must start with a --- fenced block.',
      line: 1
    })
    return issues
  }

  const declaredName =
    fm
      .match(/^name:\s*(.+)$/m)?.[1]
      .replace(/\r$/, '')
      .trim() ?? ''
  if (!declaredName) {
    issues.push({ severity: 'error', message: 'Frontmatter is missing name.', line: 1 })
  } else if (declaredName !== name) {
    issues.push({
      severity: 'error',
      message: `Frontmatter name "${declaredName}" must match the skill folder "${name}".`,
      line: lineOfKey(content, 'name')
    })
  }

  if (!parseDescription(fm)) {
    issues.push({
      severity: 'error',
      message:
        'description must not be empty — an empty description makes the skill untriggerable.',
      line: lineOfKey(content, 'description') ?? 1
    })
  }

  if (hasRolesKey(fm)) {
    const roles = parseRoles(fm)
    if (roles.length === 0) {
      issues.push({
        severity: 'error',
        message: 'roles is present but lists no role. Remove the key or name at least one role.',
        line: lineOfKey(content, 'roles')
      })
    }
    for (const r of roles.filter((r) => !KNOWN_ROLES.has(r))) {
      issues.push({
        severity: 'warning',
        message: `"${r}" is not a role I know (${[...KNOWN_ROLES].join(', ')}). The skill will rank last in every mode.`,
        line: lineOfKey(content, 'roles')
      })
    }
  }

  if (!bodyOf(content).trim()) {
    issues.push({ severity: 'error', message: 'The file has no body below the frontmatter.' })
  }

  return issues
}

export function validateReference(input: { file: string; content: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { file, content } = input

  if (!REF_TARGET_RE.test(file)) {
    issues.push({
      severity: 'error',
      message: `"${file}" is not a legal reference file name (expected e.g. jira-fields.md).`
    })
  }
  // Case-insensitive, matching `isGeneratedAsset` (assetEditable.ts): the two answer halves of
  // the same question — may this asset be opened editable, and will a save be refused — and on
  // the case-insensitive filesystems this app ships on, `index.md` IS `INDEX.md`. Comparing
  // exact-case here would let a differently-cased index open as an editable buffer while this
  // still blocked the save: the stranded-buffer state `isGeneratedAsset` exists to prevent.
  if (file.toLowerCase() === REFERENCES_INDEX.toLowerCase()) {
    issues.push({
      severity: 'error',
      message: `${REFERENCES_INDEX} is generated and cannot be edited.`
    })
  }
  if (!content.trim()) {
    issues.push({ severity: 'error', message: 'The file is empty.' })
  }
  return issues
}
