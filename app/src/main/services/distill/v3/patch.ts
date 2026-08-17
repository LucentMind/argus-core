import type { PatchOp } from '../../../../shared/distillV3'
import { fmBlock } from '../../../../shared/frontmatter'

export type PatchResult = { ok: true; text: string } | { ok: false; error: string }

const headingLevel = (line: string): number => line.match(/^(#{1,6})\s/)?.[1].length ?? 0

/** [start, end) line range of the section opened by the exact `heading` line: from the heading
 *  through the line before the next heading of the same or higher level (or EOF). */
function sectionRange(lines: string[], heading: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trimEnd() === heading.trim())
  if (start === -1) return null
  const level = headingLevel(lines[start])
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const lv = headingLevel(lines[i])
    if (lv > 0 && lv <= level) {
      end = i
      break
    }
  }
  return [start, end]
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
    } else if (op.op === 'replace-section') {
      lines.splice(start + 1, bodyEnd - (start + 1), content)
    } else if (op.op === 'insert-after') {
      lines.splice(bodyEnd, 0, '', content)
    } else {
      return { ok: false, error: `unknown op ${String((op as { op: string }).op)}` }
    }
    text = lines.join('\n')
  }
  return { ok: true, text }
}
