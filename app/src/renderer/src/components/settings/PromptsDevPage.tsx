import { useEffect, useState } from 'react'
import {
  PROMPT_CATEGORY_LABELS,
  type PromptCategory,
  type PromptCatalogPayload,
  type PromptEntryView,
  type PromptPreview
} from '../../../../shared/promptsIpc'
import { SettingsSection, SelectField } from './settingsLayout'
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

function CatalogTab({ catalog }: { catalog: PromptCatalogPayload }): React.JSX.Element {
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

function PreviewTab({ modes }: { modes: string[] }): React.JSX.Element {
  const [mode, setMode] = useState(modes[0] ?? 'investigation')
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.argus.devPrompts
      .preview(mode)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setError(e.message))
    // Guard against a slow response for a previously-selected mode overwriting a newer one.
    return () => {
      live = false
    }
  }, [mode])

  if (error) return <p className="p-3 text-xs text-danger">{error}</p>

  // Derived, not a setPreview(null) reset in the effect: the payload declares which mode it
  // was built for, so "showing another mode's text" is a comparison, not a state transition.
  // Clearing state synchronously inside the effect would cascade an extra render.
  const stale = !preview || preview.mode !== mode

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs text-dim">
        Mode
        <SelectField aria-label="Mode" value={mode} options={modes} onChange={setMode} />
      </label>

      {stale ? (
        <p className="text-xs text-mute">Loading…</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-mute">{preview.text.length} chars</span>
          </div>

          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-r2 bg-overlay p-2 font-mono text-[11px] text-ink">
            {preview.text}
          </pre>

          <SettingsSection title="Fragments" count={preview.fragments.length}>
            <div className="rounded-r2 border border-hair">
              {preview.fragments.map((f, i) => (
                <div
                  key={`${f.label}-${i}`}
                  className="flex items-center gap-2 border-b border-hair px-2 py-1 text-xs last:border-b-0"
                >
                  <span data-testid="fragment-label" className="flex-1 font-mono text-[11px]">
                    {f.label}
                  </span>
                  <span className="font-mono text-[10px] text-mute">
                    {f.start}–{f.end}
                  </span>
                </div>
              ))}
            </div>
          </SettingsSection>

          {/* Deliberately prominent, not a footnote. A reader who takes this for the whole
              prompt draws wrong conclusions about what the agent actually received — and this
              depicts the NEXT session, never one already running. */}
          <SettingsSection title="Not shown in this preview">
            <ul className="list-disc pl-5 text-xs text-dim">
              {preview.omits.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </SettingsSection>
        </>
      )}
    </div>
  )
}

export function PromptsDevPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<PromptCatalogPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'catalog' | 'preview'>('catalog')

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
      <div className="flex gap-1 border-b border-hair">
        {(
          [
            ['catalog', 'Catalog'],
            ['preview', 'Composed preview']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`border-b-2 px-2.5 py-1.5 text-xs ${
              tab === id ? 'border-signal text-ink' : 'border-transparent text-dim hover:text-ink'
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'catalog' ? <CatalogTab catalog={catalog} /> : <PreviewTab modes={catalog.modes} />}
    </div>
  )
}
