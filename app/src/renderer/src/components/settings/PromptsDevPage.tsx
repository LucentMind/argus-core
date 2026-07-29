import { useEffect, useState } from 'react'
import {
  PROMPT_CATEGORY_LABELS,
  type PromptCategory,
  type PromptCatalogPayload,
  type PromptCaptureDetail,
  type PromptCaptureListPayload,
  type PromptEntryView,
  type PromptPreview
} from '../../../../shared/promptsIpc'
import type { DistillEvalExportResult } from '../../../../shared/distillEval'
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

function CaptureTab(): React.JSX.Element {
  const [list, setList] = useState<PromptCaptureListPayload | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<PromptCaptureDetail | null>(null)
  // The key the *last resolved response* belongs to — kept separately from `detail` because a
  // successful-but-empty response (record vanished) also sets `detail` to null, and that must
  // stay distinguishable from "haven't asked yet" / "still loading".
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.argus.devPrompts
      .captures()
      .then(setList)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (!openKey) return
    let live = true
    const key = openKey
    const [caseSlug, sessionId] = key.split('#')
    window.argus.devPrompts
      .capture(caseSlug, Number(sessionId))
      .then((d) => {
        if (!live) return
        setDetail(d)
        setDetailKey(key)
      })
      .catch((e: Error) => live && setError(e.message))
    // Guard against a slow response for a previously-selected row overwriting a newer one.
    return () => {
      live = false
    }
  }, [openKey])

  if (error) return <p className="p-3 text-xs text-danger">{error}</p>
  if (!list) return <p className="p-3 text-xs text-mute">Loading…</p>
  const rows = list.rows
  if (rows.length === 0)
    return (
      <p className="p-3 text-xs text-mute">
        No sessions captured yet. Open a case and start a session — one record is written per
        session construction.
      </p>
    )
  // list.total counts every record found, before the DEFAULT_LIST_LIMIT cap — silently rendering
  // only `rows` as though it were everything is exactly what Finding 4 exists to prevent.
  const truncated = list.total > rows.length

  // Derived, not reset in an effect: the payload names the session it describes, so showing
  // another row's detail is a comparison, not a state transition.
  const shown = detail && openKey === `${detail.capture.caseSlug}#${detail.capture.sessionId}`
  // A resolved response for the currently-open row that came back null — the record was on the
  // list a moment ago but is gone now (ring-buffer eviction keeps only the newest 50 per case, or
  // it was deleted). Distinct from "still loading", which is neither `shown` nor `missing`.
  const missing = !shown && detailKey === openKey && detail === null

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection title="Recent sessions" count={rows.length}>
        <div className="rounded-r2 border border-hair">
          {rows.map((r) => (
            <button
              key={`${r.caseSlug}#${r.sessionId}`}
              onClick={() => setOpenKey(`${r.caseSlug}#${r.sessionId}`)}
              className="flex w-full items-center gap-2 border-b border-hair px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-overlay"
            >
              <span className="flex-1 font-mono text-[11px] text-ink">
                {r.caseSlug} · session {r.sessionId}
              </span>
              <Chip tone="neutral">{r.mode}</Chip>
              <Chip tone="neutral">{r.driverKind}</Chip>
              {/* Deliberately loud. A session that received NO persona must not read as a
                  session with a short one — that misreading is the reason this tab exists. */}
              {r.transport === 'none' ? (
                <Chip tone="danger">
                  <span data-testid={`transport-none-${r.caseSlug}-${r.sessionId}`}>
                    prompt dropped
                  </span>
                </Chip>
              ) : (
                <Chip tone="neutral">{r.transport}</Chip>
              )}
              {r.overrideCount > 0 && <Chip tone="defect">{r.overrideCount} overridden</Chip>}
              <span className="font-mono text-[10px] text-mute">{r.chars} chars</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      {truncated && (
        <p className="text-xs text-mute">
          showing {rows.length} of {list.total}
        </p>
      )}

      {missing && (
        <p className="rounded-r2 border border-hair bg-overlay p-2 text-xs text-dim">
          This capture is no longer on disk. It was most likely evicted by the ring buffer (which
          keeps only the newest 50 records per case) or deleted. Pick another row from the list
          above.
        </p>
      )}

      {shown && detail && (
        <>
          {detail.capture.transport === 'none' && (
            <p
              role="alert"
              className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
            >
              This driver forwarded no system prompt. The text below was composed and discarded —
              the model never saw the persona, citation rules, mode identity, skill index or memory
              index.
            </p>
          )}
          {!detail.personaMatchesCurrent && (
            <p
              data-testid="persona-drift"
              className="rounded-r2 border border-defect/40 bg-defect/10 p-2 text-xs text-defect"
            >
              The persona has changed since this session started — an override was set or cleared,
              or the code moved. Compare against the Composed preview tab.
            </p>
          )}

          <SettingsSection title="What this session was built with">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1 px-2 py-1 text-xs">
              <dt className="text-dim">Driver</dt>
              <dd className="font-mono text-[11px]">{detail.capture.driverKind}</dd>
              <dt className="text-dim">Transport</dt>
              <dd data-testid="capture-transport" className="font-mono text-[11px]">
                {detail.capture.transport}
              </dd>
              <dt className="text-dim">Model</dt>
              <dd className="font-mono text-[11px]">
                {detail.capture.model ?? '(driver default)'}
              </dd>
              <dt className="text-dim">Mode</dt>
              <dd className="font-mono text-[11px]">{detail.capture.mode}</dd>
              <dt className="text-dim">Permission mode</dt>
              <dd className="font-mono text-[11px]">{detail.capture.permissionMode}</dd>
              <dt className="text-dim">Started</dt>
              <dd className="font-mono text-[11px]">{detail.capture.createdAt}</dd>
              <dt className="text-dim">Active overrides</dt>
              <dd data-testid="capture-overrides" className="font-mono text-[11px]">
                {detail.capture.activeOverrides.join(', ') || 'none'}
              </dd>
            </dl>
          </SettingsSection>

          <SettingsSection
            title="System append (exact bytes)"
            count={detail.capture.systemAppend.length}
          >
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap rounded-r2 bg-overlay p-2 font-mono text-[11px] text-ink">
              {detail.capture.systemAppend}
            </pre>
          </SettingsSection>

          <SettingsSection title="Fragments" count={detail.capture.fragments.length}>
            <div className="rounded-r2 border border-hair">
              {detail.capture.fragments.map((f, i) => (
                <div
                  key={`${f.label}-${i}`}
                  className="flex items-center gap-2 border-b border-hair px-2 py-1 text-xs last:border-b-0"
                >
                  <span className="flex-1 font-mono text-[11px]">{f.label}</span>
                  {f.overridden && (
                    <Chip tone="defect">
                      <span data-testid="fragment-overridden">overridden</span>
                    </Chip>
                  )}
                  <span className="font-mono text-[10px] text-mute">{f.chars} chars</span>
                </div>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="Tools advertised" count={detail.capture.tools.length}>
            <div className="rounded-r2 border border-hair">
              {detail.capture.tools.map((t) => (
                <div
                  key={`${t.origin}-${t.name}`}
                  className="flex items-center gap-2 border-b border-hair px-2 py-1 text-xs last:border-b-0"
                >
                  <span className="flex-1 font-mono text-[11px]">{t.name}</span>
                  <Chip tone="neutral">{t.origin}</Chip>
                </div>
              ))}
            </div>
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
  const [tab, setTab] = useState<'catalog' | 'preview' | 'capture'>('catalog')
  const [exportResult, setExportResult] = useState<DistillEvalExportResult | null>(null)
  const [exporting, setExporting] = useState(false)

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
            ['preview', 'Composed preview'],
            ['capture', 'Session capture']
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
      {tab === 'catalog' && <CatalogTab catalog={catalog} onSave={save} onReset={reset} />}
      {tab === 'preview' && <PreviewTab modes={catalog.modes} />}
      {tab === 'capture' && <CaptureTab />}
      <SettingsSection title="Distill eval export">
        <div className="flex flex-col gap-2 px-2 py-2 text-xs">
          <p className="text-dim">
            Bundles each case&apos;s latest fully-reviewed distill job — full input snapshot, raw
            output, prompt hash, and accept/reject labels — into an NDJSON file for the in-repo eval
            harness (tools/distill-eval). Snapshots contain raw case data: treat the file as
            sensitive and commit it only to the private evals repo.
          </p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-r2 border border-hair px-2 py-1 text-xs text-ink disabled:text-faint"
              disabled={exporting}
              onClick={() => {
                setExporting(true)
                void window.argus.devPrompts
                  .exportDistillEval()
                  .then((r) => setExportResult(r))
                  .catch((e: Error) => setMutationError(e.message))
                  .finally(() => setExporting(false))
              }}
            >
              Export distill eval bundle
            </button>
            {exportResult && (
              <span className="font-mono text-[11px] text-mute">
                {exportResult.exported} job{exportResult.exported === 1 ? '' : 's'} →{' '}
                {exportResult.path}
                {exportResult.skipped.length > 0 && ` · ${exportResult.skipped.length} skipped`}
              </span>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}
