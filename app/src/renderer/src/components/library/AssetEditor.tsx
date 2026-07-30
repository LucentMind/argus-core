import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles } from 'lucide-react'
import { Btn } from '../ui'
import { ModalShell } from '../ModalShell'
import { AssistProgress } from './AssistProgress'
import { useAssistProvider } from './assistProvider'
import { diffLines } from '../../lib/lineDiff'
import { confirm } from '../../lib/confirmStore'
import {
  validateSkill,
  validateReference,
  hasErrors,
  type ValidationIssue
} from '../../../../shared/assetValidation'
import type { AuthoringKind } from '../../../../shared/authoringIpc'

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

// eslint-disable-next-line react-refresh/only-export-components -- templates co-located with the component that consumes them; Task 8 imports them too, see LibraryPage.tsx for the same pattern
export function skillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Use when … (name the situation, the artifacts involved, and the words a user would say)',
    '# roles: [triage, review]   # optional — omit to apply in both modes',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    '## Method',
    '',
    '1. ',
    ''
  ].join('\n')
}

// eslint-disable-next-line react-refresh/only-export-components -- templates co-located with the component that consumes them; Task 8 imports them too, see LibraryPage.tsx for the same pattern
export function referenceTemplate(name: string): string {
  const title = name.replace(/\.md$/, '').replace(/[-_]/g, ' ')
  return [
    `# ${title}`,
    '',
    'One-sentence overview — this seeds the references index.',
    '',
    '## ',
    ''
  ].join('\n')
}

export interface AssetEditorProps {
  kind: AuthoringKind
  /** Skill folder name / reference file name. In create mode, the initial value of the name field. */
  name: string
  mode: 'edit' | 'create'
  /** Absent in create mode. */
  load?: () => Promise<{ content: string; hash: string }>
  /** Resolves to the new base hash — the hash of what was actually written to disk. Both
   *  write paths (`writeUserSkill`, `RefSyncService.writeReference`) already compute this;
   *  the editor must adopt it into `baseHash`, or the very next save is guaranteed to throw
   *  a "changed on disk" conflict caused by this save itself. */
  save: (args: { name: string; content: string; baseHash: string | null }) => Promise<string>
  onClose: () => void
  onSaved?: (name: string) => void
}

/**
 * The write half of the Library. Deliberately separate from MarkdownViewer, which stays a
 * ~55-line reader: this owns buffer/dirty state, validation, the assist overlay, and conflict
 * reporting. Both are driven by injected load/save callbacks, so one component serves skills,
 * references — and, later, pending proposals (spec §9).
 */
export function AssetEditor({
  kind,
  name: initialName,
  mode,
  load,
  save,
  onClose,
  onSaved
}: AssetEditorProps): React.JSX.Element {
  const template = kind === 'skill' ? skillTemplate : referenceTemplate
  const [name, setName] = useState(initialName)
  const [buffer, setBuffer] = useState(mode === 'create' ? template(initialName) : '')
  const [baseHash, setBaseHash] = useState<string | null>(null)
  const [bufferPristine, setBufferPristine] = useState(true)
  const [loaded, setLoaded] = useState(mode === 'create')
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [describe, setDescribe] = useState('')
  const [proposed, setProposed] = useState<string | null>(null)
  const provider = useAssistProvider()
  // Which assist is in flight, for the progress row's wording. null = none.
  const [phase, setPhase] = useState<'draft' | 'improve' | null>(null)
  /**
   * Monotonic id for assist requests. Bumped on every start AND on Stop waiting, so a
   * resolution can tell it has been abandoned and drop its result. Cancelling cannot kill the
   * underlying run — `runHeadless` takes no AbortSignal — so abandoning the result is the
   * honest semantics, and the button says "Stop waiting" rather than implying otherwise.
   */
  const runId = useRef(0)
  // Guards a resolution landing after unmount; `load()` has the same protection.
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  // Read across the `await` in `assist()` so a resolution can tell whether `buffer` moved
  // (typing, or a rename that regenerated the template) while the request was in flight,
  // instead of deciding replace-vs-diff against the stale value closed over at click time.
  const bufferRef = useRef(buffer)
  useEffect(() => {
    bufferRef.current = buffer
  }, [buffer])

  /**
   * Whether closing would throw away something the user produced.
   *
   * Deliberately NOT `bufferPristine`: that flag means "the buffer is still untouched
   * boilerplate", which `renameCreate` needs to stay true so it can keep re-deriving the
   * template. In create mode a typed name and a typed Describe prompt are real work that
   * leaves the buffer pristine, so keying the close guard on that flag discarded both
   * without asking. `busy` counts too — closing mid-run throws the run away.
   */
  const hasUnsavedWork =
    !bufferPristine ||
    proposed !== null ||
    busy ||
    (mode === 'create' && (name !== initialName || describe.trim() !== ''))

  useEffect(() => {
    if (!load) return
    let live = true
    load().then(
      ({ content, hash }) => {
        // The textarea (the only way to touch `buffer` in edit mode) doesn't render until
        // `loaded` is true, and both flip in this same batched update — so there is no
        // render in which a user edit could be sitting in `buffer` for this to clobber.
        if (!live) return
        setBuffer(content)
        // Assigned synchronously (not left to the passive-effect sync below) so a draft
        // resolution landing in the ~1ms gap between this commit and the effect flush sees
        // the true current buffer, not a stale snapshot. See the comment on `bufferRef`.
        bufferRef.current = content
        setBaseHash(hash)
        setLoaded(true)
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
    // load is mount-stable: callers remount (key/conditional render) per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const issues: ValidationIssue[] = useMemo(
    () =>
      kind === 'skill'
        ? validateSkill({ name, content: buffer })
        : validateReference({ file: name, content: buffer }),
    [kind, name, buffer]
  )
  const blocked = hasErrors(issues)

  function edit(next: string): void {
    setBuffer(next)
    // Synchronous, not left to the passive-effect sync — see the comment on `bufferRef`.
    bufferRef.current = next
    setBufferPristine(false)
    setError(null)
  }

  /** Create-mode name field: while the buffer is still untouched boilerplate, keep the
   *  frontmatter `name:` in sync so a rename doesn't leave a stale name/folder mismatch
   *  behind. Once the user has actually edited the buffer, this must never fire again. */
  function renameCreate(next: string): void {
    setName(next)
    if (bufferPristine) {
      const nextBuffer = template(next)
      setBuffer(nextBuffer)
      // Synchronous, not left to the passive-effect sync — see the comment on `bufferRef`.
      bufferRef.current = nextBuffer
    }
    setError(null)
  }

  async function onSave(): Promise<void> {
    if (blocked) {
      setError(issues.find((i) => i.severity === 'error')!.message)
      return
    }
    setBusy(true)
    setError(null)
    // Snapshot what was actually sent to `save`. The textarea stays editable during `busy`
    // (disabling it would swallow keystrokes), so by the time the IPC round trip resolves,
    // `buffer` may have moved on. Compare against `bufferRef.current` — not the `buffer`
    // closed over here, which is frozen at click time and can't see later typing — to find
    // out whether that happened.
    const savedContent = buffer
    try {
      const newHash = await save({ name, content: savedContent, baseHash })
      // Adopt before deciding whether to close: when the buffer moved during the round trip
      // and the editor stays open below, the next Save must compare against what's actually
      // on disk now — not the hash this save started with, which the write just invalidated.
      setBaseHash(newHash)
      onSaved?.(name)
      if (bufferRef.current === savedContent) {
        onClose()
      } else {
        // What was on screen when Save was clicked is now safely on disk, but the user kept
        // typing during the round trip — closing now would silently drop that text and leave
        // it not matching the hash that was just written. Keep the editor open instead.
        setError(
          'Saved, but you kept typing while it was saving — those newer changes have not been saved yet.'
        )
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function assist(which: 'draft' | 'improve'): Promise<void> {
    const myRun = ++runId.current
    setBusy(true)
    setPhase(which)
    setError(null)
    // Snapshot what "untouched boilerplate" looked like at click time. `bufferPristine` and
    // `buffer` are read fresh here (not stale) because this runs synchronously before the
    // first await.
    const wasPristine = bufferPristine
    const bufferAtRequest = buffer
    try {
      const req = { kind, name, text: which === 'draft' ? describe : buffer }
      const { content } =
        which === 'draft'
          ? await window.argus.authoring.draft(req)
          : await window.argus.authoring.improve(req)
      // Abandoned via Stop waiting, superseded by a newer run, or unmounted: drop the result.
      if (runId.current !== myRun || !mounted.current) return
      // Decide replace-vs-diff against state *at resume time*, not the closure captured when
      // the click happened: `bufferRef.current` reflects any typing, or any rename that
      // regenerated the template, that happened while the request was in flight. Only replace
      // outright when both nothing was typed (`wasPristine`) and the buffer truly hasn't moved
      // since — otherwise route through the diff so the in-flight edit is never silently lost.
      if (which === 'draft' && wasPristine && bufferRef.current === bufferAtRequest) {
        setBuffer(content)
        // Synchronous, not left to the passive-effect sync — see the comment on `bufferRef`.
        bufferRef.current = content
        setBufferPristine(false)
      } else {
        setProposed(content)
      }
    } catch (e) {
      if (runId.current !== myRun || !mounted.current) return
      setError((e as Error).message)
    } finally {
      if (runId.current === myRun && mounted.current) {
        setBusy(false)
        setPhase(null)
      }
    }
  }

  /** Give the editor back without waiting. The run continues; its result is discarded. */
  function stopWaiting(): void {
    runId.current++
    setBusy(false)
    setPhase(null)
  }

  async function requestClose(): Promise<void> {
    if (
      !hasUnsavedWork ||
      (await confirm({ title: 'Discard your changes?', confirmLabel: 'Discard', danger: true }))
    ) {
      onClose()
    }
  }

  const label = `${kind} · ${name}`

  return (
    <ModalShell
      title={`${kind === 'skill' ? 'skills' : 'references'} / ${name}`}
      ariaLabel={label}
      onClose={() => void requestClose()}
      className="h-[80vh] w-[80vw] max-w-4xl"
      actions={
        <>
          <Btn variant="ghost" disabled={proposed !== null} onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Preview'}
          </Btn>
          <Btn variant="ghost" onClick={() => void requestClose()}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={busy || !loaded || proposed !== null}
            onClick={() => void onSave()}
          >
            Save
          </Btn>
        </>
      }
    >
      {mode === 'create' && (
        <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
          <input
            aria-label={`${kind} name`}
            value={name}
            disabled={proposed !== null}
            onChange={(e) => renameCreate(e.target.value)}
            className="w-56 rounded-r2 bg-black/20 px-2 py-1 font-mono text-xs outline-none"
          />
          <input
            aria-label="describe it"
            placeholder="Describe what it should do…"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            className="min-w-0 flex-1 rounded-r2 bg-black/20 px-2 py-1 text-xs outline-none placeholder:text-faint"
          />
          {proposed === null && !preview && (
            <Btn
              variant="outline"
              disabled={busy || !describe.trim() || provider?.ok === false}
              onClick={() => void assist('draft')}
            >
              <Sparkles size={13} aria-hidden="true" />
              Draft
            </Btn>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-3 mt-2 rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-sm text-dim">
          {error ? 'File could not be read.' : 'Loading…'}
        </div>
      ) : (
        <>
          {proposed !== null ? (
            <>
              <pre className="flex-1 overflow-auto px-4 py-3 font-mono text-xs">
                {diffLines(buffer, proposed).map((l, i) => (
                  <div key={i} className={KIND_CLASS[l.kind]}>
                    {KIND_PREFIX[l.kind]}
                    {l.text}
                  </div>
                ))}
              </pre>
              <div className="flex justify-end gap-2 border-t border-hair px-3 py-2">
                <Btn variant="ghost" onClick={() => setProposed(null)}>
                  Discard
                </Btn>
                <Btn
                  variant="primary"
                  onClick={() => {
                    edit(proposed)
                    setProposed(null)
                  }}
                >
                  Accept
                </Btn>
              </div>
            </>
          ) : preview ? (
            <div className="markdown-body flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
              <Markdown remarkPlugins={[remarkGfm]}>{buffer}</Markdown>
            </div>
          ) : (
            <textarea
              aria-label={label}
              spellCheck={false}
              value={buffer}
              onChange={(e) => edit(e.target.value)}
              className="flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-ink outline-none"
            />
          )}

          {!preview && proposed === null && (
            <div className="flex items-center justify-between gap-2 border-t border-hair px-3 py-2">
              <span className="flex flex-col gap-0.5">
                {issues.map((i, n) => (
                  <span
                    key={n}
                    role={i.severity === 'error' ? undefined : 'status'}
                    className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-review'}`}
                  >
                    {i.severity === 'error' ? '⚠' : '•'} {i.message}
                    {i.line !== undefined && ` (line ${i.line})`}
                  </span>
                ))}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {provider && (
                  <span className={`text-xs ${provider.ok ? 'text-faint' : 'text-danger'}`}>
                    {provider.ok ? provider.text : provider.reason}
                  </span>
                )}
                <Btn
                  variant="outline"
                  disabled={busy || !buffer.trim() || provider?.ok === false}
                  onClick={() => void assist('improve')}
                >
                  <Sparkles size={13} aria-hidden="true" />
                  Improve
                </Btn>
              </span>
            </div>
          )}
        </>
      )}

      {phase !== null && (
        <AssistProgress
          phase={phase}
          providerText={provider?.ok ? provider.text : undefined}
          onStopWaiting={stopWaiting}
        />
      )}
    </ModalShell>
  )
}
