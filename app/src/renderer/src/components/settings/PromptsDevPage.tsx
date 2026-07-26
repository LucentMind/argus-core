import { useEffect, useState } from 'react'
import {
  PROMPT_CATEGORY_LABELS,
  type PromptCategory,
  type PromptCatalogPayload,
  type PromptEntryView
} from '../../../../shared/promptsIpc'
import { SettingsSection } from './settingsLayout'
import { Chip } from '../ui'

/** Fixed display order. Iterating this rather than the PromptCategory union is deliberate:
 *  two categories are empty until Plan 3, and rendering a heading per union member would
 *  advertise sections that hold nothing — implying the catalog is complete when it is not. */
const DISPLAY_ORDER: PromptCategory[] = [
  'persona',
  'session-context',
  'tools',
  'tool-feedback',
  'headless',
  'generated-files',
  'synthesized',
  'external'
]

function ReachChips({ reaches }: { reaches: readonly string[] | 'all' }): React.JSX.Element {
  if (reaches === 'all') return <Chip tone="neutral">all drivers</Chip>
  return (
    <>
      {reaches.map((r) => (
        <Chip key={r} tone="neutral">
          {r}
        </Chip>
      ))}
    </>
  )
}

function EntryRow({ entry }: { entry: PromptEntryView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const isExternal = entry.category === 'external'
  return (
    <div className="border-b border-hair last:border-b-0">
      <button
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-hair/40"
        onClick={() => setOpen(!open)}
      >
        <span className="flex-1 text-ink">{entry.title}</span>
        <span className="font-mono text-[10px] text-faint">{entry.source}</span>
        <span className="font-mono text-[10px] text-mute">{entry.chars} chars</span>
        <ReachChips reaches={entry.reaches} />
        {isExternal && <Chip tone="review">read-only</Chip>}
      </button>
      {open && (
        <div className="px-2 pb-2">
          {isExternal ? (
            <p className="text-xs text-dim">{entry.note}</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-r2 bg-overlay p-2 font-mono text-[11px] text-ink">
              {entry.overrideText ?? entry.defaultText}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export function PromptsDevPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<PromptCatalogPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.argus.devPrompts
      .catalog()
      .then(setCatalog)
      // The gate refusal must be visible. A blank page would read as "no prompts exist".
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <p className="p-3 text-xs text-danger">{error}</p>
  if (!catalog) return <p className="p-3 text-xs text-mute">Loading…</p>

  return (
    <div className="flex flex-col gap-3">
      {DISPLAY_ORDER.map((cat) => {
        const entries = catalog.entries.filter((e) => e.category === cat)
        if (entries.length === 0) return null
        return (
          <SettingsSection key={cat} title={PROMPT_CATEGORY_LABELS[cat]} count={entries.length}>
            <div className="rounded-r2 border border-hair">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </div>
          </SettingsSection>
        )
      })}
    </div>
  )
}
