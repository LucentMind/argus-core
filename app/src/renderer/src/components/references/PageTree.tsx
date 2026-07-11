import { useEffect, useRef, useState } from 'react'
import { Chip } from '../ui'
import { pageSelected, type SpaceConfig, type TreeNodeVM } from '../../../../shared/referenceSync'

export interface PageTreeProps {
  space: SpaceConfig
  root: TreeNodeVM
  loadChildren: (pageId: string) => Promise<TreeNodeVM[]>
  onToggle: (pageId: string, ancestorIds: string[]) => void
}

/**
 * Lazy tri-state curation tree (spec §3.2). Checked state derives purely from
 * the SpaceConfig selection via pageSelected; indeterminate is an aggregate
 * over *loaded* descendants (unloaded markers can't render — acceptable).
 */
export function PageTree({
  space,
  root,
  loadChildren,
  onToggle
}: PageTreeProps): React.JSX.Element {
  const [kids, setKids] = useState<Record<string, TreeNodeVM[] | 'loading'>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.id]))
  const requested = useRef(new Set<string>())

  const load = (id: string): void => {
    if (requested.current.has(id)) return // re-expanding never refetches
    requested.current.add(id)
    setKids((k) => ({ ...k, [id]: 'loading' }))
    void loadChildren(id).then((nodes) => setKids((k) => ({ ...k, [id]: nodes })))
  }

  useEffect(() => {
    if (root.hasChildren) load(root.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.id])

  const hasSelectedDescendant = (id: string, ancestors: string[]): boolean => {
    const c = kids[id]
    if (!Array.isArray(c)) return false
    return c.some(
      (n) =>
        pageSelected(space, n.id, [id, ...ancestors]) ||
        hasSelectedDescendant(n.id, [id, ...ancestors])
    )
  }

  const row = (node: TreeNodeVM, ancestors: string[]): React.JSX.Element => {
    const checked = pageSelected(space, node.id, ancestors)
    const indeterminate = !checked && hasSelectedDescendant(node.id, ancestors)
    const isExpanded = expanded.has(node.id)
    const children = kids[node.id]
    return (
      <div key={node.id} role="treeitem" aria-expanded={node.hasChildren ? isExpanded : undefined}>
        <div
          className="flex items-center gap-2 py-0.5"
          style={{ paddingLeft: ancestors.length * 16 }}
        >
          {node.hasChildren ? (
            <button
              aria-label={`expand · ${node.title}`}
              className="text-dim w-4"
              onClick={() => {
                const next = new Set(expanded)
                if (isExpanded) next.delete(node.id)
                else {
                  next.add(node.id)
                  load(node.id)
                }
                setExpanded(next)
              }}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <input
            type="checkbox"
            aria-label={`select · ${node.title}`}
            checked={checked}
            ref={(el) => {
              if (el) el.indeterminate = indeterminate
            }}
            onChange={() => onToggle(node.id, ancestors)}
          />
          <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>
          {Array.isArray(children) && (
            <span className="text-faint text-xs">{children.length} children</span>
          )}
          {node.lastModified && (
            <span className="text-faint text-xs">{node.lastModified.slice(0, 10)}</span>
          )}
          {node.isNew && <Chip tone="signal">NEW</Chip>}
          {node.outdated && <Chip tone="neutral">outdated?</Chip>}
        </div>
        {isExpanded && children === 'loading' && (
          <div className="text-faint pl-8 text-xs">loading…</div>
        )}
        {isExpanded &&
          Array.isArray(children) &&
          children.map((c) => row(c, [node.id, ...ancestors]))}
      </div>
    )
  }

  return <div role="tree">{row(root, [])}</div>
}
