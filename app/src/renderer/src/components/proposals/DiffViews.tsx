import { Fragment } from 'react'
import { diffLines, pairRows } from '../../lib/lineDiff'
import type { DiffCell } from '../../lib/lineDiff'
import { MessageView } from '../MessageView'
import { KIND_PREFIX, KIND_CLASS } from './diffUtils'

/** Proposals carry no citations — `MessageView`'s cite handler has nothing to do here. */
const noop = (): void => undefined

export type { DiffViewMode } from './diffUtils'
// eslint-disable-next-line react-refresh/only-export-components -- re-export of a pure helper co-located with the diff components that consume it; see ToolRow.tsx for the same pattern
export { diffStat } from './diffUtils'

export function UnifiedDiff({
  current,
  content
}: {
  current: string | null
  content: string
}): React.JSX.Element {
  const lines = diffLines(current ?? '', content)
  return (
    // `break-words`: `whitespace-pre-wrap` only wraps at existing whitespace — an unbroken
    // token (long URL/path/minified line, no spaces) has no break opportunity and needs
    // overflow-wrap to avoid growing past the pane. jsdom cannot see this; live-verified 2026-08-08.
    <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs">
      {lines.map((l, i) => (
        <div key={i} className={KIND_CLASS[l.kind]}>
          {KIND_PREFIX[l.kind]}
          {l.text}
        </div>
      ))}
    </pre>
  )
}

/** One side of a split row; null cell = filler opposite an unpaired add/del. */
function SplitCell({ cell }: { cell: DiffCell | null }): React.JSX.Element {
  return (
    <>
      <span className="select-none px-2 text-right text-faint">{cell?.no ?? ''}</span>
      <span
        className={`whitespace-pre-wrap pr-3 ${
          cell
            ? `${KIND_CLASS[cell.kind]} ${
                cell.kind === 'add' ? 'bg-signal/5' : cell.kind === 'del' ? 'bg-danger/5' : ''
              }`
            : 'bg-hair/30'
        }`}
      >
        {cell?.text ?? ''}
      </span>
    </>
  )
}

export function SplitDiff({
  current,
  content
}: {
  current: string | null
  content: string
}): React.JSX.Element {
  const rows = pairRows(diffLines(current ?? '', content))
  return (
    <div className="overflow-x-auto py-3 font-mono text-xs">
      <div className="grid min-w-fit grid-cols-[auto_1fr_auto_1fr]">
        {rows.map((r, i) => (
          <Fragment key={i}>
            <SplitCell cell={r.left} />
            <SplitCell cell={r.right} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export function ProposedView({ content }: { content: string }): React.JSX.Element {
  return <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs text-dim">{content}</pre>
}

/** Leading YAML frontmatter, split off a markdown document. `front` is null when there is none —
 *  references and recipes have no frontmatter at all, so that is half the assets. */
function splitFrontmatter(content: string): { front: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content)
  return m ? { front: m[1], body: content.slice(m[0].length) } : { front: null, body: content }
}

/**
 * A brand-new file: the proposed content, formatted, with no diff around it (user-directed,
 * 2026-08-08). There is no `current` to compare against, so Unified and Split were both just the
 * whole file with a `+` in front of every line, and the three-way view toggle above them offered
 * a choice between one real answer and two dressings of it.
 *
 * Frontmatter is held out of the markdown deliberately: a skill's `---` block renders as a
 * horizontal rule, a run-on paragraph and a stray heading if fed to the renderer, and it is
 * exactly the part a reviewer reads literally (the name and description are what the agent will
 * match on). Body below it renders as the markdown it is.
 */
export function NewFileView({ content }: { content: string }): React.JSX.Element {
  const { front, body } = splitFrontmatter(content)
  return (
    <div className="min-w-0 px-5 py-3">
      {front !== null && (
        <pre className="mb-4 overflow-x-auto whitespace-pre-wrap break-words rounded-r2 border border-hair bg-hair/30 px-3 py-2 font-mono text-[11px] text-dim">
          {front}
        </pre>
      )}
      <MessageView markdown={body} onCite={noop} />
    </div>
  )
}
