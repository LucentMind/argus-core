import { useEffect, useRef, useState } from 'react'
import { FileText, PencilLine, Sparkles } from 'lucide-react'
import { modeFromQuery, rankAssets, rankCommands, type AssetRow } from '../../lib/palette'
import { transientFieldEscape, useEscapeLayer } from '../../lib/escapeLayer'
import { TIER_LABELS, type TrustTier } from '../../../../shared/trustTiers'
import type { Command } from '../../lib/commands'

export interface CommandPaletteProps {
  /** The raw query, `>` and all. Owned by the host so Ctrl+Shift+P can open pre-filled. */
  raw: string
  onRawChange: (raw: string) => void
  commands: readonly Command[]
  assets: readonly AssetRow[]
  onPickAsset: (row: AssetRow) => void
  onDiscardDraft: (row: AssetRow) => void
  onClose: () => void
}

/** DOM ids for `aria-activedescendant`. Not exported: `react-refresh/only-export-components`
 *  allows this file to export the component and its types, and nothing else. */
function optionId(id: string): string {
  return `palette-opt-${id}`
}

function rowKey(row: Command | AssetRow, mode: 'assets' | 'commands'): string {
  return mode === 'commands' ? (row as Command).id : (row as AssetRow).id
}

const KIND_ICON = { skill: Sparkles, reference: FileText, draft: PencilLine } as const

/**
 * Spec §6.2 (quick open) and §6.4 (the palette), as **one** overlay.
 *
 * Which list it shows is derived from the query (`modeFromQuery`), not held as a second piece of
 * state — so typing `>` switches to commands and backspacing over it switches back, with nothing
 * to keep in sync. Ctrl+P opens it empty; Ctrl+Shift+P opens it holding `>`.
 *
 * The highlight is **clamped during render** rather than reset from an effect: a synchronous
 * `setState` in a `useEffect` body is forbidden here (`react-hooks/set-state-in-effect`), and
 * every path that shortens the list is already a handler that can reset it.
 */
export function CommandPalette({
  raw,
  onRawChange,
  commands,
  assets,
  onPickAsset,
  onDiscardDraft,
  onClose
}: CommandPaletteProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)
  useEscapeLayer({ onEscape: onClose })

  const { mode, query } = modeFromQuery(raw)
  const rows: readonly (Command | AssetRow)[] =
    mode === 'commands' ? rankCommands(commands, query) : rankAssets(assets, query)
  // Clamped, not corrected: `rows` can shrink under a stale index between a keystroke and the
  // handler that resets it, and an out-of-range read would blank `aria-activedescendant`.
  const active = rows.length === 0 ? -1 : Math.min(index, rows.length - 1)
  const activeRow = active === -1 ? null : rows[active]!

  useEffect(() => {
    // jsdom has no `scrollIntoView` at all (not even a no-op), so the call itself — not just the
    // lookup chain — needs the `?.`, matching the convention already used in ChatPane.
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, raw])

  const pick = (row: Command | AssetRow): void => {
    if (mode === 'commands') {
      const cmd = row as Command
      // Disabled rows are shown rather than hidden — a user hunting for Save all should learn
      // that it exists — but they do nothing, and they do not dismiss the palette either.
      if (!cmd.enabled) return
      onClose()
      cmd.run()
      return
    }
    onClose()
    onPickAsset(row as AssetRow)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(rows.length === 0 ? 0 : (active + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(rows.length === 0 ? 0 : (active - 1 + rows.length) % rows.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setIndex(Math.max(0, rows.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeRow) pick(activeRow)
    } else if (e.key === 'Delete' && mode === 'assets') {
      const row = activeRow as AssetRow | null
      if (row?.draft) {
        e.preventDefault()
        onDiscardDraft(row)
      }
    } else {
      // The house two-stage rule: clear a non-empty field, blur an empty one so the NEXT Escape
      // reaches the escape layer and closes the overlay. `escapeLayer` deliberately ignores
      // Escape while a field has focus, so without this the palette would be unclosable by
      // keyboard from inside its own input.
      transientFieldEscape(e, raw === '', () => onRawChange(''))
    }
  }

  return (
    <div
      data-testid="palette-backdrop"
      className="modal-scrim fixed inset-0 z-50 flex justify-center pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={mode === 'commands' ? 'Commands' : 'Open asset'}
        className="flex max-h-[60vh] w-[min(38rem,90vw)] flex-col overflow-hidden rounded-r3 border border-hair bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded={true}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-label={mode === 'commands' ? 'Search commands' : 'Search skills and references'}
          {...(activeRow ? { 'aria-activedescendant': optionId(rowKey(activeRow, mode)) } : {})}
          placeholder={mode === 'commands' ? 'Command…' : 'Skill or reference… (> for commands)'}
          value={raw}
          onChange={(e) => {
            onRawChange(e.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
          className="shrink-0 border-b border-hair bg-transparent px-4 py-3 text-sm outline-none placeholder:text-faint"
        />
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-dim">
            {mode === 'commands' ? 'No matching commands.' : 'No matching assets.'}
          </div>
        ) : (
          <ul
            id="palette-list"
            ref={listRef}
            role="listbox"
            aria-label="Results"
            className="min-h-0 overflow-auto py-1"
          >
            {rows.map((row, i) => {
              if (mode === 'commands') {
                const cmd = row as Command
                return (
                  <li
                    key={cmd.id}
                    id={optionId(cmd.id)}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={!cmd.enabled || undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(cmd)}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-1.5 text-xs ${
                      i === active ? 'bg-hi' : ''
                    } ${cmd.enabled ? 'text-ink' : 'text-faint'}`}
                  >
                    <span className="flex min-w-0 gap-2">
                      <span className="w-14 shrink-0 text-faint">{cmd.section}</span>
                      <span className="truncate">{cmd.title}</span>
                    </span>
                    {cmd.keybinding && (
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {cmd.keybinding}
                      </span>
                    )}
                  </li>
                )
              }
              const asset = row as AssetRow
              const Icon = KIND_ICON[asset.kind]
              const label =
                asset.tier && asset.tier in TIER_LABELS
                  ? TIER_LABELS[asset.tier as TrustTier]
                  : null
              // The Drafts section header is drawn at the first draft row rather than by grouping
              // the list, so ranking stays one flat pass and the arrow keys walk one sequence
              // (spec §6.2 puts drafts in their own section; `rankAssets` sorts them last). Derived
              // from the previous row rather than a mutable "seen" flag: `react-hooks/immutability`
              // forbids reassigning a render-scoped variable across iterations.
              const prev = i > 0 ? (rows[i - 1] as AssetRow) : null
              const header = asset.kind === 'draft' && (!prev || prev.kind !== 'draft')
              return (
                <li
                  key={asset.id}
                  id={optionId(asset.id)}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(asset)}
                  className={`cursor-pointer px-4 py-1.5 text-xs ${i === active ? 'bg-hi' : ''}`}
                >
                  {header && (
                    <span className="mb-1 block border-t border-hair pt-1 text-[11px] uppercase tracking-wide text-faint">
                      Drafts
                    </span>
                  )}
                  <span className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon size={13} aria-hidden="true" className="shrink-0 text-faint" />
                      <span className="truncate font-mono">{asset.name}</span>
                      {(asset.title || asset.description) && (
                        <span className="truncate text-faint">
                          {asset.title || asset.description}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {label && (
                        <span className="rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim">
                          {label}
                        </span>
                      )}
                      {asset.draft && (
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            // Without this the row's own onClick would open the draft in the same
                            // gesture that discarded it.
                            e.stopPropagation()
                            onDiscardDraft(asset)
                          }}
                          className="rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim hover:text-danger"
                        >
                          Discard
                        </button>
                      )}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
