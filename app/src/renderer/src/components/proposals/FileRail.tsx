import { Chip } from '../ui'
import { diffStat } from './DiffViews'
import type { ProposalFile } from '../../../../shared/proposals'

// The reserved key travels alongside `FileRail` (Task 3's ProposalDetail and Task 4's editor
// both import it from here) rather than living in its own module. No suppression is needed:
// this repo's react-refresh/only-export-components config sets `allowConstantExport: true`
// (see eslint.config.mjs's use of the `vite` preset), which permits exactly this shape — a
// component file that also exports a primitive constant.
/** The reserved key for the proposal body, in selection state and in the edited-files map.
 *  `acceptProposal` keeps the body in `editedContent`, so this key never travels over IPC. */
export const BODY_PATH = 'SKILL.md'

/**
 * The file list beside the diff for a proposal that carries siblings.
 *
 * WAI-ARIA tablist rather than a plain list: each entry swaps the pane beside it, which is what
 * a tab is. It also gives the tests a stable role to query instead of asserting on classes,
 * which jsdom cannot see anyway.
 */
export function FileRail({
  files,
  body,
  selected,
  onSelect,
  editedPaths
}: {
  files: ProposalFile[]
  /** The proposal body, rendered as the first entry so `SKILL.md` is reviewed like any file. */
  body: { current: string | null; content: string }
  selected: string
  onSelect: (path: string) => void
  editedPaths: ReadonlySet<string>
}): React.JSX.Element {
  const entries = [
    { path: BODY_PATH, current: body.current, content: body.content, exec: false },
    ...files
  ]
  return (
    <div
      role="tablist"
      aria-label="Files in this proposal"
      // `max-h-24 overflow-y-auto`: MAX_ASSET_FILES is 32, so the rail (BODY_PATH + up to 32
      // siblings) can wrap to a ~200px header on a pane whose diff area is the point. Caps the
      // rail and lets it scroll instead. jsdom does not lay out flexbox, so this cannot be
      // asserted in a test — needs a live eyeball.
      className="flex max-h-24 shrink-0 flex-wrap gap-1 overflow-y-auto border-b border-hair px-5 py-2"
    >
      {entries.map((e) => {
        const isNew = e.current === null
        const stat = isNew ? null : diffStat(e.current, e.content)
        const unreadable = 'unreadable' in e && e.unreadable === true
        return (
          <button
            key={e.path}
            role="tab"
            aria-selected={selected === e.path}
            onClick={() => onSelect(e.path)}
            className={`flex items-center gap-1.5 rounded-r2 border px-2 py-1 text-xs transition-colors ${
              selected === e.path
                ? 'border-hair2 bg-overlay text-ink'
                : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            <span className="font-mono">{e.path}</span>
            {e.exec && <Chip tone="review">exec</Chip>}
            {unreadable && <Chip tone="review">unreadable</Chip>}
            {editedPaths.has(e.path) && <Chip tone="signal">edited</Chip>}
            {isNew ? (
              <span className="text-mute">new</span>
            ) : (
              stat && (
                <span className="font-mono">
                  <span className="text-signal">+{stat.adds}</span>{' '}
                  <span className="text-danger">−{stat.dels}</span>
                </span>
              )
            )}
          </button>
        )
      })}
    </div>
  )
}
