import type { PatchOp } from '../../../../shared/distillV3'
import { fmBlock } from '../../../../shared/frontmatter'

export type PatchResult = { ok: true; text: string } | { ok: false; error: string }

const headingLevel = (line: string): number => line.match(/^(#{1,6})\s/)?.[1].length ?? 0

/** A line starting with ``` or ~~~ toggles fence state. `#`-prefixed lines inside a fence are
 *  never headings (e.g. a `# comment` inside a ```bash block). */
const isFenceDelim = (line: string): boolean => {
  const t = line.trimStart()
  return t.startsWith('```') || t.startsWith('~~~')
}

/** True if the text's ``` / ~~~ fence delimiters are unbalanced, i.e. the last fence opened
 *  never closes. An unterminated fence would otherwise make `sectionRange` skip every
 *  subsequent line (including the real next heading), silently corrupting the patch. */
function hasUnterminatedFence(text: string): boolean {
  let inFence = false
  for (const line of text.split('\n')) {
    if (isFenceDelim(line)) inFence = !inFence
  }
  return inFence
}

/** [start, end) line range of the section opened by the exact `heading` line: from the heading
 *  through the line before the next heading of the same or higher level (or EOF).
 *  Only the FIRST matching heading line is targeted; duplicate headings are ambiguous by
 *  design and callers must disambiguate before patching. Lines inside a fenced code block
 *  are skipped entirely — they can never match the heading, nor end the section. */
function sectionRange(lines: string[], heading: string): [number, number] | null {
  const target = heading.trim()
  let inFence = false
  let start = -1
  let level = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (isFenceDelim(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (start === -1) {
      if (lines[i].trimEnd() === target) {
        start = i
        level = headingLevel(lines[i])
      }
      continue
    }
    const lv = headingLevel(lines[i])
    if (lv > 0 && lv <= level) {
      end = i
      break
    }
  }
  if (start === -1) return null
  return [start, end]
}

/** If the line at `idx` exists and is a heading, splice in a blank line ahead of it so an
 *  inserted block never abuts the next heading. */
function ensureBlankBeforeHeading(lines: string[], idx: number): void {
  if (idx < lines.length && headingLevel(lines[idx]) > 0) {
    lines.splice(idx, 0, '')
  }
}

/** Trailing blank lines of a range are kept AFTER the inserted content so section spacing survives. */
function splitTrailingBlank(lines: string[], start: number, end: number): number {
  let e = end
  while (e > start + 1 && lines[e - 1].trim() === '') e--
  return e
}

export function applyPatch(
  original: string,
  ops: PatchOp[],
  frontmatter?: { description?: string } | null
): PatchResult {
  let text = original.replace(/\r\n/g, '\n')
  if (hasUnterminatedFence(text)) return { ok: false, error: 'unterminated code fence in target' }
  if (frontmatter && frontmatter.description !== undefined) {
    const b = fmBlock(text)
    if (!b) return { ok: false, error: 'frontmatter change on a file with no frontmatter' }
    const fmLines = b.fm.split('\n')
    const i = fmLines.findIndex((l) => /^description:/.test(l))
    const line = `description: ${frontmatter.description}`
    if (i === -1) fmLines.push(line)
    else fmLines[i] = line
    text = `---\n${fmLines.join('\n')}\n---\n${b.body}`
  }
  for (const op of ops) {
    const lines = text.split('\n')
    const content = op.content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (hasUnterminatedFence(content)) {
      return { ok: false, error: 'unterminated code fence in op content' }
    }
    if (op.op === 'append-file') {
      text = text.replace(/\n*$/, '\n\n') + content + '\n'
      continue
    }
    if (!op.heading) return { ok: false, error: `${op.op} requires a heading` }
    const range = sectionRange(lines, op.heading)
    if (!range) return { ok: false, error: `heading not found: ${op.heading}` }
    const [start, end] = range
    const bodyEnd = splitTrailingBlank(lines, start, end)
    if (op.op === 'append-section') {
      lines.splice(bodyEnd, 0, content)
      ensureBlankBeforeHeading(lines, bodyEnd + 1)
    } else if (op.op === 'replace-section') {
      lines.splice(start + 1, bodyEnd - (start + 1), content)
      ensureBlankBeforeHeading(lines, start + 2)
    } else if (op.op === 'insert-after') {
      lines.splice(bodyEnd, 0, '', content)
      ensureBlankBeforeHeading(lines, bodyEnd + 2)
    } else {
      return { ok: false, error: `unknown op ${String((op as { op: string }).op)}` }
    }
    text = lines.join('\n')
  }
  return { ok: true, text }
}
