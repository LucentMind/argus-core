import { useEffect, useState } from 'react'
import {
  PROMPT_CATEGORY_LABELS,
  type PromptCategory,
  type PromptCatalogPayload,
  type PromptEntryView,
  type PromptPreview
} from '../../../../shared/promptsIpc'
import { SettingsSection, SelectField, TEXTAREA_FIELD } from './settingsLayout'
import { Chip } from '../ui'
import { confirm } from '../../lib/confirmStore'

/** Fixed display order. Iterating this rather than the PromptCategory union is deliberate: the
 *  union is a type, and a heading rendered per union member would advertise a section even
 *  when nothing in the build populates it — implying the catalog is complete when it is not.
 *  Empty categories are skipped at render time below. */
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

function EntryRow({
  entry,
  onSave,
  onReset
}: {
  entry: PromptEntryView
  onSave: (id: string, text: string) => Promise<void>
  onReset: (id: string) => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const isExternal = entry.category === 'external'
  const effective = entry.overrideText ?? entry.defaultText
  const [draft, setDraft] = useState(effective)
  const [lastEffective, setLastEffective] = useState(effective)
  // Adjust-state-during-render (react.dev "you might not need an effect"): a save replaces the
  // catalog, so the draft must follow the new effective text without a setState-in-effect.
  if (effective !== lastEffective) {
    setLastEffective(effective)
    setDraft(effective)
  }
  const dirty = draft !== effective

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
        {entry.overrideText !== null && <Chip tone="defect">overridden</Chip>}
        {isExternal && <Chip tone="review">read-only</Chip>}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          {isExternal ? (
            <p className="text-xs text-dim">{entry.note}</p>
          ) : !entry.editable ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-r2 bg-overlay p-2 font-mono text-[11px] text-ink">
              {effective}
            </pre>
          ) : (
            <>
              <textarea
                aria-label={`Prompt text · ${entry.title}`}
                className={`${TEXTAREA_FIELD} min-h-64`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              {entry.placeholders && (
                <p className="text-[11px] text-dim">
                  Must keep:{' '}
                  <span className="font-mono text-mute">
                    {entry.placeholders.map((p) => `{${p}}`).join(' ')}
                  </span>{' '}
                  — each carries a runtime value into the message.
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  className="rounded-r2 border border-hair px-2 py-1 text-xs text-ink disabled:text-faint"
                  disabled={!dirty}
                  onClick={() => void onSave(entry.id, draft)}
                >
                  Save
                </button>
                <button
                  className="rounded-r2 border border-hair px-2 py-1 text-xs text-dim disabled:text-faint"
                  disabled={!dirty}
                  onClick={() => setDraft(effective)}
                >
                  Revert
                </button>
                <button
                  className="rounded-r2 border border-hair px-2 py-1 text-xs text-dim disabled:text-faint"
                  disabled={entry.overrideText === null}
                  onClick={() => void onReset(entry.id)}
                >
                  Reset to default
                </button>
                <span className="font-mono text-[10px] text-faint">
                  default {entry.defaultText.length} chars
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function CatalogTab({
  catalog,
  onSave,
  onReset
}: {
  catalog: PromptCatalogPayload
  onSave: (id: string, text: string) => Promise<void>
  onReset: (id: string) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {catalog.loadError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          The override file could not be parsed — running on defaults. ({catalog.loadError})
        </p>
      )}
      {DISPLAY_ORDER.map((cat) => {
        const entries = catalog.entries.filter((e) => e.category === cat)
        if (entries.length === 0) return null
        return (
          <SettingsSection key={cat} title={PROMPT_CATEGORY_LABELS[cat]} count={entries.length}>
            <div className="rounded-r2 border border-hair">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} onSave={onSave} onReset={onReset} />
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
  // Separate from `error`: that state fully replaces the page (see below), which would blank
  // the catalog the user was just editing. A failed save/reset must stay visible without
  // hiding the entries they're looking at.
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [tab, setTab] = useState<'catalog' | 'preview'>('catalog')

  useEffect(() => {
    const reload = (): void => {
      window.argus.devPrompts
        .catalog()
        .then(setCatalog)
        // The gate refusal must be visible. A blank page would read as "no prompts exist".
        .catch((e: Error) => setError(e.message))
    }
    reload()
    // The banner and this page are mounted as siblings (SettingsView.tsx) and both react to the
    // same broadcast. Without this, clearing overrides from the banner leaves this page showing
    // stale "overridden" chips and stale draft text — editing and saving that draft would
    // re-apply an override the developer just deliberately deleted.
    return window.argus.devPrompts.onChanged(reload)
  }, [])

  const save = async (id: string, text: string): Promise<void> => {
    try {
      setCatalog(await window.argus.devPrompts.setOverride(id, text))
      setMutationError(null)
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  const reset = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: 'Reset this prompt to its default?',
      message:
        'The override is deleted. This takes effect on the next session. Any unsaved draft edit in the box below is discarded too.',
      confirmLabel: 'Reset',
      danger: true
    })
    if (!ok) return
    try {
      setCatalog(await window.argus.devPrompts.clearOverride(id))
      setMutationError(null)
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  if (error) return <p className="p-3 text-xs text-danger">{error}</p>
  if (!catalog) return <p className="p-3 text-xs text-mute">Loading…</p>

  return (
    <div className="flex flex-col gap-3">
      {mutationError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {mutationError}
        </p>
      )}
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
      {tab === 'catalog' ? (
        <CatalogTab catalog={catalog} onSave={save} onReset={reset} />
      ) : (
        <PreviewTab modes={catalog.modes} />
      )}
    </div>
  )
}
