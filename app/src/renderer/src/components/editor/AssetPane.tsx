import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Btn } from '../ui'
import { AssistProgress } from '../library/AssistProgress'
import { useAssistProvider } from '../library/assistProvider'
import { skillTemplate, referenceTemplate } from '../library/assetTemplates'
import { CodeSurface } from './CodeSurface'
import { DiffView } from './DiffView'
import { readAsset, writeAsset } from './assetIo'
import { clockTime } from '../../lib/time'
import {
  isConflict,
  onExternalChange,
  resolveConflict,
  type ConflictAction,
  type DraftBanner
} from '../../lib/draftState'
import {
  hasErrors,
  validateReference,
  validateSkill,
  type ValidationIssue
} from '../../../../shared/assetValidation'
import type { CursorInfo, SurfaceHandle } from './surface'
import type { AuthoringKind } from '../../../../shared/authoringIpc'
import type { DraftRecord } from '../../../../shared/editorIpc'

export interface AssetPaneProps {
  kind: AuthoringKind
  /** Skill folder / reference file name. In create mode, the initial value of the name field. */
  initialName: string
  mode: 'edit' | 'create'
  /** What the surface opens with: the draft when there is one, otherwise disk or the template. */
  initialDoc: string
  /**
   * The text that counts as *no unsaved work*. Disk content in edit mode, the template in create
   * mode — and deliberately **not** `initialDoc`, because a restored draft must open dirty.
   *
   * This one value replaces Increment 2's `bufferPristine` + `savedClean` + `everMirrored`.
   * Dirty is now derived (`doc !== baseline`) rather than tracked, which is why the mount-echo
   * and untouched-template special cases have no equivalent here: a document that equals the
   * baseline is not work, whatever path put it there.
   */
  initialBaseline: string
  initialHash: string | null
  initialBanner: DraftBanner
  initialDraftAt: string | null
  /**
   * Other create-mode drafts this tab could resume (spec §4.5, pulled forward by `0862aa4f`).
   * Empty in edit mode. Resolved by `AssetTab` so this component does no async work of its own.
   */
  otherDrafts: DraftRecord[]
  onDirtyChange: (dirty: boolean) => void
}

/**
 * One asset, in a window. Absorbs everything Increment 2 split between `AssetTab` (draft,
 * banners, conflict) and `library/AssetEditor` (buffer, validation, assist, save), which is
 * possible — and much smaller than the sum — because CodeMirror owns the document now.
 *
 * Mounted with resolved values and keyed on the asset, so every state initialiser below is a
 * plain value. There is no `generation`, no `override` and no `init.load`: content changes are
 * transactions through {@link SurfaceHandle}, not remounts.
 */
export function AssetPane({
  kind,
  initialName,
  mode,
  initialDoc,
  initialBaseline,
  initialHash,
  initialBanner,
  initialDraftAt,
  otherDrafts,
  onDirtyChange
}: AssetPaneProps): React.JSX.Element {
  const template = kind === 'skill' ? skillTemplate : referenceTemplate
  const surfaceRef = useRef<SurfaceHandle | null>(null)

  const [name, setName] = useState(initialName)
  const [savedName, setSavedName] = useState(initialName)
  const [describe, setDescribe] = useState('')
  const [doc, setDoc] = useState(initialDoc)
  const [baseline, setBaseline] = useState(initialBaseline)
  const [banner, setBanner] = useState<DraftBanner>(initialBanner)
  const [draftAt, setDraftAt] = useState<string | null>(initialDraftAt)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selected: 0 })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'draft' | 'improve' | null>(null)
  const [proposed, setProposed] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  // A snapshot taken when Compare was clicked. State, not a live ref read: the repo's
  // react-hooks/refs rule forbids reading `.current` during render, and this is rendered
  // straight from the function body.
  const [compareSnapshot, setCompareSnapshot] = useState<string | null>(null)
  const provider = useAssistProvider()

  // Mirrors of the four values that async paths and CodeMirror callbacks have to read *now*
  // rather than as captured at subscribe time. Each is written synchronously at the point its
  // state counterpart is set — never left to a passive effect — because `onDocChange` fires
  // inside CodeMirror's dispatch, which is before React has committed anything.
  const docRef = useRef(initialDoc)
  const baselineRef = useRef(initialBaseline)
  const baseHashRef = useRef<string | null>(initialHash)
  const filedAsRef = useRef(initialName)
  const bannerRef = useRef<DraftBanner>(initialBanner)
  useEffect(() => {
    bannerRef.current = banner
  }, [banner])

  const runId = useRef(0)
  // Guards every async resolution against landing after unmount. The setup function must assign
  // `true` rather than relying on `useRef(true)`: dev-mode StrictMode double-invokes mount
  // effects (setup, simulated cleanup, setup), reusing the same ref — without re-arming, the
  // simulated cleanup leaves this false for the component's entire real lifetime and every
  // guarded path silently takes its "unmounted" branch. Invisible in production and in jsdom;
  // only a real dev boot ever showed it.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  /** Replace the document *and* declare what the new "no unsaved work" text is, in that order. */
  const applyContent = useCallback((text: string, nextBaseline: string): void => {
    // The refs are written before the dispatch, not after. `surface.setDoc` calls back into
    // `handleDocChange` synchronously, and that callback decides whether to persist a draft by
    // comparing against `baselineRef.current`. Setting state alone would leave it reading the
    // previous baseline and re-persisting a draft the caller is in the middle of discarding.
    baselineRef.current = nextBaseline
    docRef.current = text
    setBaseline(nextBaseline)
    setDoc(text)
    surfaceRef.current?.setDoc(text)
  }, [])

  const handleDocChange = useCallback(
    (text: string): void => {
      docRef.current = text
      setDoc(text)
      setError(null)
      // Spec §4.2: a file you merely opened never gets a draft. Equality with the baseline also
      // covers every programmatic reset that declares a new baseline (Use disk, discard draft, a
      // save landing, a create-mode template regeneration) — those must not re-persist what they
      // just settled. A deliberate revert back to the baseline text is caught here too, and
      // correctly: the draft file is removed by whichever path set that baseline.
      if (text === baselineRef.current) return
      window.argus.editor.draftChanged({
        kind,
        name: filedAsRef.current,
        mode,
        content: text,
        baseHash: baseHashRef.current
      })
    },
    [kind, mode]
  )

  useEffect(
    () =>
      window.argus.editor.onDraftSaved((s) => {
        // The only thing allowed to claim the draft is kept: it fires strictly after the bytes
        // are on disk (persist-before-adopt, spec §4.2).
        if (s.kind === kind && s.name === filedAsRef.current) setDraftAt(s.updatedAt)
      }),
    [kind]
  )

  const issues: ValidationIssue[] = useMemo(
    () =>
      kind === 'skill'
        ? validateSkill({ name, content: doc })
        : validateReference({ file: name, content: doc }),
    [kind, name, doc]
  )
  const blocked = hasErrors(issues)

  /**
   * Spec §3.5 / §6.1's dirty signal, and the one the close handshake asks about.
   *
   * `busy` and `proposed` count: closing mid-run throws the run away, and an unresolved proposal
   * is work the user has not decided on. In create mode a typed name and a typed Describe prompt
   * are real work even while the document is still the untouched template.
   */
  const dirty =
    proposed !== null ||
    busy ||
    doc !== baseline ||
    name !== savedName ||
    (mode === 'create' && describe.trim() !== '')

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  // A saved-then-unmounted pane must not leave the host believing work is still dirty.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  /** Create mode: while the document is still the untouched template, keep the frontmatter
   *  `name:` in step with the name field. Once the user has edited it, never again. */
  function renameCreate(next: string): void {
    const previous = filedAsRef.current
    setName(next)
    setError(null)
    const untouched = docRef.current === baselineRef.current
    const content = untouched ? template(next) : docRef.current
    if (untouched) applyContent(content, content)
    filedAsRef.current = next
    // Persisted explicitly rather than through `handleDocChange`: a typed name is work even when
    // the document did not move, and §4.5's re-key is only reachable from here.
    window.argus.editor.draftChanged({
      kind,
      name: next,
      mode,
      content,
      baseHash: baseHashRef.current,
      ...(next !== previous ? { replaces: { kind, name: previous } } : {})
    })
  }

  async function onSave(): Promise<void> {
    if (blocked) {
      setError(issues.find((i) => i.severity === 'error')!.message)
      return
    }
    setBusy(true)
    setError(null)
    // Snapshot what is actually being written. The surface stays editable during the round trip
    // (disabling it would swallow keystrokes), so `docRef.current` may move past this.
    const savedContent = docRef.current
    const savedAs = name
    try {
      const newHash = await writeAsset(kind, savedAs, savedContent, baseHashRef.current)
      if (!liveRef.current) return
      // Adopt before anything else: the next save has to be measured against what this write
      // just put on disk, not the hash it started from.
      baseHashRef.current = newHash
      filedAsRef.current = savedAs
      setSavedName(savedAs)
      setBanner({ kind: 'none' })
      // What was written is the new baseline either way. When the buffer moved on during the
      // round trip it stays dirty against it, which is exactly right.
      baselineRef.current = savedContent
      setBaseline(savedContent)
      if (docRef.current === savedContent) {
        setDraftAt(null)
        void window.argus.editor.discardDraft({ kind, name: savedAs })
      } else {
        // Re-file against the hash just written, or a restore would compare against a hash this
        // very save invalidated and cry staleness.
        window.argus.editor.draftChanged({
          kind,
          name: savedAs,
          mode,
          content: docRef.current,
          baseHash: newHash
        })
        setError(
          'Saved, but you kept typing while it was saving — those newer changes have not been saved yet.'
        )
      }
    } catch (e) {
      // Classified by re-reading disk, not by matching main's message: that text is not an API,
      // and the create-mode name collision is thrown from the same hash comparison.
      const disk = await readAsset(kind, savedAs)
      if (!liveRef.current) return
      if (isConflict(baseHashRef.current, disk)) {
        setBanner({ kind: 'conflict', disk: disk! })
        setError('This file changed on disk — resolve it above.')
      } else {
        setError((e as Error).message)
      }
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  async function assist(which: 'draft' | 'improve'): Promise<void> {
    const myRun = ++runId.current
    setBusy(true)
    setPhase(which)
    setError(null)
    const wasUntouched = docRef.current === baselineRef.current
    const docAtRequest = docRef.current
    try {
      const req = { kind, name, text: which === 'draft' ? describe : docRef.current }
      const { content } =
        which === 'draft'
          ? await window.argus.authoring.draft(req)
          : await window.argus.authoring.improve(req)
      // Abandoned via Stop waiting, superseded by a newer run, or unmounted: drop the result.
      if (runId.current !== myRun || !liveRef.current) return
      if (which === 'draft' && wasUntouched && docRef.current === docAtRequest) {
        // Nothing typed to lose and nothing to compare against — land it directly. Still a
        // transaction, so it is still Ctrl+Z-able; the baseline is deliberately left alone, so
        // this counts as work and gets drafted.
        surfaceRef.current?.setDoc(content)
      } else {
        setProposed(content)
      }
    } catch (e) {
      if (runId.current !== myRun || !liveRef.current) return
      setError((e as Error).message)
    } finally {
      if (runId.current === myRun && liveRef.current) {
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

  const discardDraft = useCallback(async (): Promise<void> => {
    await window.argus.editor.discardDraft({ kind, name: filedAsRef.current })
    const disk = await readAsset(kind, filedAsRef.current)
    if (!liveRef.current) return
    setDraftAt(null)
    setBanner({ kind: 'none' })
    if (disk) {
      baseHashRef.current = disk.hash
      applyContent(disk.content, disk.content)
    }
    // Increment 2 had to unmount the editor before these awaits, because a keystroke landing
    // mid-flight would be silently reverted by the remount that followed. That hazard is gone:
    // this is a transaction, so anything typed in the gap is one Ctrl+Z away rather than lost.
  }, [kind, applyContent])

  const apply = useCallback(
    (action: ConflictAction): void => {
      const b = bannerRef.current
      if (b.kind !== 'stale' && b.kind !== 'conflict') return
      const next = resolveConflict(action, { buffer: docRef.current, disk: b.disk })
      baseHashRef.current = next.baseHash
      setCompareSnapshot(null)
      setBanner({ kind: 'none' })
      if (next.discardDraft) {
        // Use disk: the document becomes exactly what is on disk, so that is the new baseline
        // and the pane is genuinely clean.
        void window.argus.editor.discardDraft({ kind, name: filedAsRef.current })
        setDraftAt(null)
        applyContent(next.content, next.content)
      } else {
        // Keep mine: the text does not move, but the draft file on disk still carries the
        // pre-resolution `baseHash`. Left alone, the next reopen would compare that stale hash
        // against disk and re-ask a question the user already answered — so re-file it against
        // the new hash. `draftAt` is untouched: only `onDraftSaved` may claim a draft is kept.
        window.argus.editor.draftChanged({
          kind,
          name: filedAsRef.current,
          mode,
          content: next.content,
          baseHash: next.baseHash
        })
      }
    },
    [kind, mode, applyContent]
  )

  /** Spec §4.4: no fs watcher — external changes are noticed here and at save. */
  useEffect(() => {
    const check = (): void => {
      // A banner already up means the user is mid-decision; do not move the ground under them.
      if (bannerRef.current.kind !== 'none') return
      void (async () => {
        const disk = await readAsset(kind, filedAsRef.current)
        if (!liveRef.current || !disk) return
        if (bannerRef.current.kind !== 'none') return
        const next = onExternalChange({
          dirty: docRef.current !== baselineRef.current,
          baseHash: baseHashRef.current,
          disk
        })
        if (next.reload) {
          baseHashRef.current = disk.hash
          applyContent(disk.content, disk.content)
        } else if (next.banner.kind !== 'none') {
          setBanner(next.banner)
        }
      })()
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [kind, applyContent])

  // `name` is React state here, so the collision needs no mirrored copy of it — the original
  // needed `typedName` only because the name lived inside AssetEditor.
  const collision = otherDrafts.find((d) => d.name === name) ?? null
  const resumeDraft = (target: string): void => {
    void window.argus.editor.open({ kind, name: target, mode: 'create' })
  }

  const compare =
    compareSnapshot !== null && (banner.kind === 'stale' || banner.kind === 'conflict')
      ? { disk: banner.disk, snapshot: compareSnapshot }
      : null
  // Anything that takes the editor's place on screen. All three keep the surface **mounted**
  // (see the wrapper below): unmounting CodeMirror discards undo history and cursor position on
  // top of the text, which is Increment 2's Finding 1 with higher stakes.
  const overlay = compare !== null || proposed !== null || preview

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-hair px-3 py-2">
        <span className="font-mono text-xs text-dim">
          {kind === 'skill' ? 'skills' : 'references'} / {name}
        </span>
        <span className="flex items-center gap-3">
          {draftAt && (
            <span className="font-mono text-[11px] text-faint">Draft · {clockTime(draftAt)}</span>
          )}
          <span className="flex items-center gap-2">
            <Btn variant="ghost" disabled={proposed !== null} onClick={() => setPreview(!preview)}>
              {preview ? 'Edit' : 'Preview'}
            </Btn>
            <Btn
              variant="primary"
              disabled={busy || proposed !== null}
              onClick={() => void onSave()}
            >
              Save
            </Btn>
          </span>
        </span>
      </div>

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

      {banner.kind === 'restored' && (
        <div
          role="status"
          className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-r2 border border-hair bg-black/20 px-3 py-1.5 text-xs text-dim"
        >
          <span>Restored unsaved draft from {clockTime(banner.updatedAt)}.</span>
          <Btn variant="ghost" onClick={() => void discardDraft()}>
            Discard draft
          </Btn>
        </div>
      )}

      {(banner.kind === 'stale' || banner.kind === 'conflict') && (
        <div
          role="status"
          className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-r2 border border-review/40 bg-review/10 px-3 py-1.5 text-xs text-review"
        >
          <span>
            {banner.kind === 'stale'
              ? 'This file changed on disk since your draft.'
              : 'The saved version is newer than what you started from.'}
          </span>
          <span className="flex shrink-0 gap-2">
            <Btn variant="ghost" onClick={() => setCompareSnapshot(doc)}>
              Compare
            </Btn>
            <Btn variant="ghost" onClick={() => apply('use-disk')}>
              Use disk
            </Btn>
            <Btn variant="outline" onClick={() => apply('keep-mine')}>
              Keep mine
            </Btn>
          </span>
        </div>
      )}

      {mode === 'create' &&
        otherDrafts.length > 0 &&
        (collision ? (
          <div
            role="status"
            className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-r2 border border-review/40 bg-review/10 px-3 py-1.5 text-xs text-review"
          >
            <span>
              A draft named &quot;{collision.name}&quot; already exists — what you type here will
              replace it.
            </span>
            <Btn variant="outline" onClick={() => resumeDraft(collision.name)}>
              Resume it
            </Btn>
          </div>
        ) : (
          <div
            role="status"
            className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-r2 border border-hair bg-black/20 px-3 py-1.5 text-xs text-dim"
          >
            <span>
              {otherDrafts.length} unsaved new{' '}
              {kind === 'skill'
                ? otherDrafts.length === 1
                  ? 'skill'
                  : 'skills'
                : otherDrafts.length === 1
                  ? 'reference'
                  : 'references'}{' '}
              from earlier.
            </span>
            <span className="flex flex-wrap gap-2">
              {otherDrafts.map((d) => (
                <Btn key={d.name} variant="ghost" onClick={() => resumeDraft(d.name)}>
                  {d.name}
                </Btn>
              ))}
            </span>
          </div>
        ))}

      {error && (
        <div
          role="alert"
          className="mx-3 mt-2 rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {compare && (
        <DiffView
          before={compare.disk.content}
          after={compare.snapshot}
          beforeLabel="On disk"
          afterLabel="Yours"
          actions={
            <>
              {/* The wrapper below is `inert` while an overlay is up, which blurs whatever had
                  focus and drops it to <body>. Claim it back so a keyboard user lands on the
                  diff they just opened. */}
              <Btn autoFocus variant="ghost" onClick={() => setCompareSnapshot(null)}>
                Back
              </Btn>
              <Btn variant="ghost" onClick={() => apply('use-disk')}>
                Use disk
              </Btn>
              <Btn variant="primary" onClick={() => apply('keep-mine')}>
                Keep mine
              </Btn>
            </>
          }
        />
      )}

      {proposed !== null && (
        <DiffView
          before={doc}
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
                  // Defect §1.1.1, fixed: one transaction, so Ctrl+Z returns the pre-accept text.
                  surfaceRef.current?.setDoc(proposed)
                  setProposed(null)
                }}
              >
                Accept
              </Btn>
            </>
          }
        />
      )}

      {preview && !compare && proposed === null && (
        <div className="markdown-body min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
          <Markdown remarkPlugins={[remarkGfm]}>{doc}</Markdown>
        </div>
      )}

      {/* `contents` when nothing is overlaying, so the surface's own flex sizing is unchanged.
          `hidden` removes it from layout without unmounting it. `inert` + `aria-hidden` because
          Tailwind's `hidden` is only display:none where a stylesheet is loaded — true in the real
          window, false under jsdom, which has no CSS engine and would otherwise leave a second
          copy of every control in the accessibility tree. */}
      <div
        className={overlay ? 'hidden' : 'contents'}
        inert={overlay}
        aria-hidden={overlay || undefined}
      >
        <CodeSurface
          ref={surfaceRef}
          initialDoc={initialDoc}
          ariaLabel={`${kind} · ${initialName}`}
          issues={issues}
          fontSize={13}
          wrap={true}
          onDocChange={handleDocChange}
          onCursor={setCursor}
        />
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
            <span className="font-mono text-[11px] text-faint">
              {cursor.line}:{cursor.col}
            </span>
            {provider && (
              <span className={`text-xs ${provider.ok ? 'text-faint' : 'text-danger'}`}>
                {provider.ok ? provider.text : provider.reason}
              </span>
            )}
            <Btn
              variant="outline"
              disabled={busy || !doc.trim() || provider?.ok === false}
              onClick={() => void assist('improve')}
            >
              <Sparkles size={13} aria-hidden="true" />
              Improve
            </Btn>
          </span>
        </div>
      </div>

      {phase !== null && (
        <AssistProgress
          phase={phase}
          providerText={provider?.ok ? provider.text : undefined}
          onStopWaiting={stopWaiting}
        />
      )}
    </div>
  )
}
