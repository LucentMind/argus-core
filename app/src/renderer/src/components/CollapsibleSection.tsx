import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { IconBtn } from './ui'
import { uiStore, type RailPanelId } from '../lib/uiStore'

/**
 * A left-rail section that collapses to its header row.
 *
 * Lives outside `ui.tsx` on purpose: everything there is presentational and store-free, and
 * this subscribes to `uiStore`.
 *
 * `children` are rendered as DIRECT children of the container, never wrapped: all four rail
 * containers are `flex flex-col` with their own `gap-*`, which applies between direct
 * children, so a wrapper would collapse each section's internal row spacing into a single gap
 * and silently restyle all four. That is also why the toggle carries no `aria-controls` —
 * there is no body element to point at, and `aria-expanded` alone is sufficient.
 *
 * The collapsed flag lives in the store rather than in component state because these sections
 * remount on every case switch (`key={slug}` in CaseWorkspace); component state would be lost
 * each time.
 *
 * The chevron alone is the click target, not the whole header row: Repos, Pull request and
 * Related history all carry their own buttons and menus in that row, and a row-wide target
 * would swallow those clicks.
 */
export function CollapsibleSection({
  id,
  name,
  header,
  className = '',
  dataTier,
  children
}: {
  id: RailPanelId
  /** Spoken name for the toggle's accessible label: "Collapse Repos". */
  name: string
  header: ReactNode
  /** The section's own container classes, passed through verbatim. */
  className?: string
  /** Forwarded to the container. PrCompanionSection drives its P1 tier styling off this. */
  dataTier?: string
  children: ReactNode
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const collapsed = ui.railCollapsed[id]

  return (
    <div className={className} data-tier={dataTier}>
      <div className="flex items-center gap-1.5">
        <IconBtn
          size="xs"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          aria-expanded={!collapsed}
          onClick={() => uiStore.setRailSectionCollapsed(id, !collapsed)}
        >
          {collapsed ? (
            <ChevronRight size={13} strokeWidth={1.5} />
          ) : (
            <ChevronDown size={13} strokeWidth={1.5} />
          )}
        </IconBtn>
        <div className="min-w-0 flex-1">{header}</div>
      </div>
      {!collapsed && children}
    </div>
  )
}
