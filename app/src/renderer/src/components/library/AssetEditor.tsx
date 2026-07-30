import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles } from 'lucide-react'
import { Btn } from '../ui'
import { ModalShell } from '../ModalShell'
import { AssistProgress } from './AssistProgress'
import { useAssistProvider } from './assistProvider'
import { DiffView } from '../editor/DiffView'
import { confirm } from '../../lib/confirmStore'
import {
  validateSkill,
  validateReference,
  hasErrors,
  type ValidationIssue
} from '../../../../shared/assetValidation'
import type { AuthoringKind } from '../../../../shared/authoringIpc'

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
  /** 'modal' keeps the ModalShell wrapper; 'window' fills its container instead. */
  chrome?: 'modal' | 'window'
  /** Fires whenever the pristine flag flips, so the window can report dirty state to main. */
  onDirtyChange?: (dirty: boolean) => void
  /** A strip under the header — draft restore, staleness, conflict. Owned by the host so this
   *  component stays ignorant of the draft store. */
  banner?: React.ReactNode
  /** A chip in the window header (sync state). Ignored by the modal chrome. */
  status?: React.ReactNode
  /** Autosave hook. `onChange` fires whenever the user has produced something — never for a
   *  file that was merely opened. **The object identity must be stable across renders**, or the
   *  effect below re-fires on every render; memoise it in the host. */
  draft?: { onChange: (content: string, name: string) => void }
  /** Absent in create mode with nothing to restore. `hash` is null for a create-mode draft;
   *  `pristine: false` opens the buffer already dirty, which is what a restored draft is. */
  load?: () => Promise<{ content: string; hash: string | null; pristine?: boolean }>
  /** Resolves to the new base hash — the hash of what was actually written to disk. Both
   *  write paths (`writeUserSkill`, `RefSyncService.writeReference`) already compute this;
   *  the editor must adopt it into `baseHash`, or the very next save is guaranteed to throw
   *  a "changed on disk" conflict caused by this save itself. */
  save: (args: { name: string; content: string; baseHash: string | null }) => Promise<string>
  onClose: () => void
  /** Carries what was written and the hash it produced: the host needs both to decide whether
   *  to discard the draft or re-file it against the new hash. */
  onSaved?: (name: string, content: string, hash: string) => void
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
  chrome = 'modal',
  onDirtyChange,
  banner,
  status,
  draft,
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
  //
  // The setup function must set `mounted.current = true`, not just rely on `useRef(true)`'s
  // initial value. Under dev-mode React.StrictMode (both editor.tsx and main.tsx wrap their
  // trees in it), React double-invokes every mount effect once: setup, simulated cleanup, setup
  // again — reusing the same ref, not a fresh one. The simulated cleanup flips `mounted.current`
  // to false; without re-arming it here, the *second* setup call leaves it false for the
  // component's entire real lifetime, and `assist()`'s guard permanently takes its "unmounted"
  // branch — Draft/Improve resolve, but the result is dropped and the `finally` that clears
  // `busy`/`phase` never runs, so the AssistProgress overlay stays up forever with no escape but
  // Stop waiting. Production builds never double-invoke, so this is invisible there.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Read across the `await` in `assist()` so a resolution can tell whether `buffer` moved
  // (typing, or a rename that regenerated the template) while the request was in flight,
  // instead of deciding replace-vs-diff against the stale value closed over at click time.
  const bufferRef = useRef(buffer)
  useEffect(() => {
    bufferRef.current = buffer
  }, [buffer])

  /**
   * Name + content of the last successful write. A window-chrome editor stays open after a save
   * (it is a place, not a dialog), so it needs a way to say "everything on screen is on disk".
   * `bufferPristine` cannot carry that: it means "still untouched boilerplate" and `renameCreate`
   * depends on it staying false once the user has typed.
   */
  const [lastSaved, setLastSaved] = useState<{ name: string; content: string } | null>(null)
  const savedClean = lastSaved !== null && lastSaved.name === name && lastSaved.content === buffer

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
    proposed !== null ||
    busy ||
    (!savedClean &&
      (!bufferPristine || (mode === 'create' && (name !== initialName || describe.trim() !== ''))))

  // Reuse the same signal the close guard uses, rather than deriving a second, weaker one:
  // in a window the host reports this to main, which asks the same question on window close.
  useEffect(() => {
    onDirtyChange?.(hasUnsavedWork)
  }, [hasUnsavedWork, onDirtyChange])

  // A saved-then-closed editor must not leave the host believing work is still dirty: onSave
  // never flips bufferPristine (there is nothing left to make pristine — the editor is about to
  // unmount), so the last onDirtyChange delivered before unmount would otherwise be `true`. Report
  // clean on unmount unconditionally so any host — not just EditorApp — gets correct behaviour,
  // and so this also self-corrects if a host ever swaps to a different asset without unmounting.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  /**
   * Spec §4.2. Gated on the user having actually produced something: a draft written on load
   * would mean every file you merely open gets one, and the window would claim "Draft" without
   * a keystroke. A typed create-mode name counts — it is real work (see `hasUnsavedWork`), and
   * §4.5's re-key is only reachable through it.
   */
  const draftable = loaded && (!bufferPristine || (mode === 'create' && name !== initialName))
  useEffect(() => {
    if (!draftable) return
    draft?.onChange(buffer, name)
  }, [draftable, buffer, name, draft])

  useEffect(() => {
    if (!load) return
    let live = true
    load().then(
      ({ content, hash, pristine }) => {
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
        // A restored draft is by definition unsaved work. Without this the window would report
        // itself clean to main and the close handshake would let it go without a word.
        if (pristine === false) setBufferPristine(false)
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
      // Recorded on every successful write, not just the close-worthy one: in the "kept typing"
      // branch below this content really is on disk, and `savedClean` correctly stays false
      // because the buffer has since moved past it.
      setLastSaved({ name, content: savedContent })
      onSaved?.(name, savedContent, newHash)
      if (bufferRef.current === savedContent) {
        // A window is a place, not a dialog: emptying it after every save would send the user
        // back to the Library just to carry on editing the same file. `savedClean` above now
        // reports the editor clean, so the host's dirty veto drops to 0 either way. `onClose`
        // stays the modal's contract.
        if (chrome !== 'window') onClose()
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
  const title = `${kind === 'skill' ? 'skills' : 'references'} / ${name}`

  const actions = (
    <>
      <Btn variant="ghost" disabled={proposed !== null} onClick={() => setPreview(!preview)}>
        {preview ? 'Edit' : 'Preview'}
      </Btn>
      {/* In a window the frame's own close button is the cancel affordance, and it runs the
          same guard through main's close handshake. */}
      {chrome === 'modal' && (
        <Btn variant="ghost" onClick={() => void requestClose()}>
          Cancel
        </Btn>
      )}
      <Btn
        variant="primary"
        disabled={busy || !loaded || proposed !== null}
        onClick={() => void onSave()}
      >
        Save
      </Btn>
    </>
  )

  const body = (
    <>
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

      {banner}

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
            <DiffView
              before={buffer}
              after={proposed}
              beforeLabel="Current"
              afterLabel="Proposed"
              actions={
                <>
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
                </>
              }
            />
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
    </>
  )

  if (chrome === 'window') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-hair px-3 py-2">
          <span className="font-mono text-xs text-dim">{title}</span>
          <span className="flex items-center gap-3">
            {status}
            <span className="flex items-center gap-2">{actions}</span>
          </span>
        </div>
        {body}
      </div>
    )
  }

  return (
    <ModalShell
      title={title}
      ariaLabel={label}
      onClose={() => void requestClose()}
      className="h-[80vh] w-[80vw] max-w-4xl"
      actions={actions}
    >
      {body}
    </ModalShell>
  )
}
