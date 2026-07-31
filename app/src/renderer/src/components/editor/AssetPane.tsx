import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Btn } from '../ui'
import { AssistProgress } from '../library/AssistProgress'
import { useAssistProvider } from '../library/assistProvider'
import { skillTemplate, referenceTemplate } from '../library/assetTemplates'
import { CodeSurface } from './CodeSurface'
import { DiffView } from './DiffView'
import { EditorPane } from './EditorPane'
import { PreviewPane } from './PreviewPane'
import { ProblemsPanel } from './ProblemsPanel'
import { StatusBar, type SyncState } from './StatusBar'
import { readAsset, writeAsset } from './assetIo'
import type { SurfaceCommands } from './extensions/keymap'
import { clockTime } from '../../lib/time'
import {
  clampFontSize,
  FONT_DEFAULT,
  nextViewMode,
  readPrefs,
  writePrefs,
  type ViewMode
} from '../../lib/editorPrefs'
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
import type { DraftRecord, TabViewState } from '../../../../shared/editorIpc'

export interface AssetPaneProps {
  kind: AuthoringKind
  /** Skill folder / reference file name. In create mode, the initial value of the name field. */
  initialName: string
  mode: 'edit' | 'create'
  /**
   * Create mode's stable identity, minted once by `AssetTab` when the tab opened — the typed
   * name lives only in the record body, never the storage key (see `keyOf` in
   * main/services/drafts.ts). Empty string in edit mode, whose identity is the file itself and
   * is never used here.
   */
  draftId: string
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
  /** This tab is the one on screen. */
  active: boolean
  readOnly: boolean
  /** Shown in the status bar's badge slot (spec §5.5). */
  tier?: string
  onNameChange: (name: string) => void
  onViewStateChange: (view: TabViewState) => void
  /** Where this tab was looking when the app last exited. Applied on first activation. */
  initialViewState?: TabViewState | null
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
  draftId,
  initialDoc,
  initialBaseline,
  initialHash,
  initialBanner,
  initialDraftAt,
  otherDrafts,
  onDirtyChange,
  active,
  readOnly,
  tier,
  onNameChange,
  onViewStateChange,
  initialViewState = null
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
  const [prefs, setPrefs] = useState(readPrefs)
  const [editorFraction, setEditorFraction] = useState(0)
  const [problemsOpen, setProblemsOpen] = useState(false)

  const setViewMode = useCallback((viewMode: ViewMode) => {
    writePrefs({ viewMode })
    setPrefs((p) => ({ ...p, viewMode }))
  }, [])
  // A snapshot taken when Compare was clicked. State, not a live ref read: the repo's
  // react-hooks/refs rule forbids reading `.current` during render, and this is rendered
  // straight from the function body.
  const [compareSnapshot, setCompareSnapshot] = useState<string | null>(null)
  /** Name + content of the last successful write; `null` until one lands. Drives `savedClean`. */
  const [lastSaved, setLastSaved] = useState<{ name: string; content: string } | null>(null)
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

  // The same discipline, for the two halves of the persisted view state. A `TabViewState` is one
  // value, but it arrives from CodeMirror through two independent callbacks — so each one has to
  // read the other half *now*. Left to a passive effect, a scroll landing in the same tick as a
  // cursor move would persist the previous line, and a restore would put the caret on the right
  // line at the wrong scroll offset.
  const cursorRef = useRef<CursorInfo>({ line: 1, col: 1, selected: 0 })
  const scrollFractionRef = useRef(0)

  const handleCursor = useCallback(
    (info: CursorInfo): void => {
      cursorRef.current = info
      setCursor(info)
      onViewStateChange({
        line: info.line,
        col: info.col,
        scrollFraction: scrollFractionRef.current
      })
    },
    [onViewStateChange]
  )

  const handleScrollFraction = useCallback(
    (f: number): void => {
      scrollFractionRef.current = f
      setEditorFraction(f)
      // Fire-and-forget at this frequency: main owns the debounce, exactly as it does for
      // `editor:draft-changed`, which already fires on every keystroke.
      onViewStateChange({
        line: cursorRef.current.line,
        col: cursorRef.current.col,
        scrollFraction: f
      })
    },
    [onViewStateChange]
  )

  // `onSave` is a plain function declared in the component body, so it is a new identity every
  // render and cannot be captured in the `commands` memo below with an empty dependency list.
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  })

  const commands = useMemo<SurfaceCommands>(
    () => ({
      save: () => void onSaveRef.current(),
      changeFontSize: (delta) =>
        setPrefs((p) => {
          const fontSize = delta === 0 ? FONT_DEFAULT : clampFontSize(p.fontSize + delta)
          writePrefs({ fontSize })
          return { ...p, fontSize }
        }),
      toggleWrap: () =>
        setPrefs((p) => {
          writePrefs({ wrap: !p.wrap })
          return { ...p, wrap: !p.wrap }
        }),
      cycleViewMode: () =>
        setPrefs((p) => {
          const viewMode = nextViewMode(p.viewMode)
          writePrefs({ viewMode })
          return { ...p, viewMode }
        })
    }),
    []
  )

  /**
   * Window-level fallback for the commands that are not editor-scoped.
   *
   * Preview mode marks the editor subtree `inert`, which blurs it and drops focus to <body>, and
   * CodeMirror's keymap only fires while CodeMirror has focus. Without this, every §5.7 shortcut
   * dies in one of the three view modes this increment ships: Ctrl+Shift+V becomes a one-way trip
   * into Preview, and Ctrl+S stops saving the file on screen. Found by driving a real window — no
   * jsdom test shows it, because jsdom applies no CSS and does not honour `inert`.
   *
   * `defaultPrevented` is the handshake with CodeMirror's keymap: that keymap sets it whenever it
   * handled the key, so this never double-fires while the editor has focus.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && (e.key === 'v' || e.key === 'V')) commands.cycleViewMode()
      else if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) commands.save()
      else if (mod && (e.key === '=' || e.key === '+')) commands.changeFontSize(1)
      else if (mod && e.key === '-') commands.changeFontSize(-1)
      else if (mod && e.key === '0') commands.changeFontSize(0)
      else if (e.altKey && (e.key === 'z' || e.key === 'Z')) commands.toggleWrap()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commands])

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

  /**
   * Whether a draft file is believed to exist for this asset right now. Seeded from what
   * `AssetTab` resolved, then maintained by `fileDraft` / `dropDraft` below.
   *
   * Needed because "the buffer equals the baseline" and "there is no draft on disk" are
   * different facts, and conflating them is what let a hand-revert strand a draft.
   */
  const draftFiled = useRef(initialDraftAt !== null)

  const fileDraft = useCallback(
    (args: { name: string; content: string; baseHash: string | null }): void => {
      // A read-only asset must not acquire a draft: Increment 5's quick open would list it as an
      // orphan for ever, and there is no save that could ever retire it. One guard here rather
      // than at each caller: this is the only path to `editor:draft-changed`.
      if (readOnly) return
      draftFiled.current = true
      // Create mode's identity is `draftId`, carried on every write; edit mode's is kind+name,
      // already in `args.name`. See `keyOf` in main/services/drafts.ts for why the two schemes
      // differ — `replaces` (the old rename re-key routing) is gone, because a rename no longer
      // moves the storage key at all.
      window.argus.editor.draftChanged({
        kind,
        mode,
        ...args,
        ...(mode === 'create' ? { draftId } : {})
      })
    },
    [kind, mode, draftId, readOnly]
  )

  const dropDraft = useCallback(
    (name: string): void => {
      draftFiled.current = false
      setDraftAt(null)
      // Create mode discards by `draftId`; `name` is only meaningful for edit mode's kind+name
      // identity (see `keyOf` in main/services/drafts.ts).
      void window.argus.editor.discardDraft(mode === 'create' ? { draftId } : { kind, name })
    },
    [kind, mode, draftId]
  )

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
      if (text === baselineRef.current) {
        // Spec §4.2: a file you merely opened never gets a draft, so equality is normally
        // "nothing to persist". But equality is reached two ways, and one of them is a
        // **deliberate hand-revert** — type X, then backspace. The draft written on that
        // keystroke still holds the deleted text, while `dirty` below is about to report clean:
        // the window would close without a word, and the next open would hand the user back
        // text they threw away, under a "Restored unsaved draft" banner.
        //
        // The other way to reach equality is a programmatic reset that declared a new baseline
        // (Use disk, discard draft, a save landing, a create-mode template regeneration). Those
        // have already dropped or re-filed the draft themselves, so `draftFiled` is false and
        // this is a no-op. `renameCreate` is the one exception: it re-files immediately after,
        // so it pays one redundant discard in the rare untouched-rename path.
        if (draftFiled.current) {
          dropDraft(filedAsRef.current)
          // The banner describes a draft that no longer exists. Only `restored` is cleared —
          // `stale`/`conflict` describe the file on disk, not the draft, and are still true.
          setBanner((b) => (b.kind === 'restored' ? { kind: 'none' } : b))
        }
        return
      }
      fileDraft({ name: filedAsRef.current, content: text, baseHash: baseHashRef.current })
    },
    [fileDraft, dropDraft]
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
   *
   * `savedClean` keys on `lastSaved` rather than on `baseline` deliberately: `lastSaved === null`
   * until a save actually lands, which is what lets a typed Describe prompt count as work
   * *before* the first save and stop counting after it. Without that gate the canonical create
   * flow — name, Describe prompt, body, Save — leaves the pane reporting dirty for the rest of
   * its life, because `describe` is never cleared and `mode` never changes.
   */
  const savedClean = lastSaved !== null && lastSaved.name === name && lastSaved.content === doc
  const dirty =
    proposed !== null ||
    busy ||
    (!savedClean &&
      (doc !== baseline || name !== savedName || (mode === 'create' && describe.trim() !== '')))

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  // A saved-then-unmounted pane must not leave the host believing work is still dirty.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  /** Create mode: while the document is still the untouched template, keep the frontmatter
   *  `name:` in step with the name field. Once the user has edited it, never again. */
  function renameCreate(next: string): void {
    setName(next)
    setError(null)
    // `lastSaved === null` is load-bearing, not belt-and-braces. "The buffer equals the baseline"
    // is NOT the same question as "is this still untouched boilerplate": `onSave` sets
    // `baselineRef.current = savedContent`, so after a save the equality flips back to true and a
    // rename would regenerate the template over the user's just-saved body. Increment 2 got this
    // right with `bufferPristine`, a **monotone** flag a save never reset. Collapsing it into
    // `baselineRef` is correct for `dirty` (which is why `savedClean` stayed separate) but wrong
    // here — this is the third consumer, and it needs the discarded meaning.
    const untouched = lastSaved === null && docRef.current === baselineRef.current
    const content = untouched ? template(next) : docRef.current
    if (untouched) applyContent(content, content)
    filedAsRef.current = next
    // Persisted explicitly rather than through `handleDocChange`: a typed name is work even when
    // the document did not move. No re-key here any more — create mode's storage key is
    // `draftId`, not the name, so a rename never moves the file (see `keyOf` in
    // main/services/drafts.ts).
    fileDraft({ name: next, content, baseHash: baseHashRef.current })
    // The tab strip shows the name, and in create mode this field owns it.
    onNameChange(next)
  }

  async function onSave(): Promise<void> {
    // Separate from the guard below, and first: the button's `disabled` is not the only way in —
    // Ctrl+S arrives through the CodeMirror keymap and the window-level fallback, neither of
    // which looks at the button at all.
    if (readOnly) return
    // The Save *button* is disabled on `busy || proposed !== null`, but Ctrl+S reaches this
    // function through two paths that ignore the button entirely — the CodeMirror keymap and the
    // window-level fallback. Without this guard a double Ctrl+S (a very common habit) starts a
    // second save while the first is in flight, and the second fails in a way that reports a
    // conflict that does not exist.
    if (busy || proposed !== null) return
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
      setLastSaved({ name: savedAs, content: savedContent })
      setBanner({ kind: 'none' })
      // What was written is the new baseline either way. When the buffer moved on during the
      // round trip it stays dirty against it, which is exactly right.
      baselineRef.current = savedContent
      setBaseline(savedContent)
      if (docRef.current === savedContent) {
        dropDraft(savedAs)
      } else {
        // Re-file against the hash just written, or a restore would compare against a hash this
        // very save invalidated and cry staleness.
        fileDraft({ name: savedAs, content: docRef.current, baseHash: newHash })
        setError(
          'Saved, but you kept typing while it was saving — those newer changes have not been saved yet.'
        )
      }
      // Deliberately last: a parent-supplied callback can throw, and everything above it is this
      // save's own state machine — the baseline adoption and draft drop. If this ran earlier and
      // threw, execution would land in `catch` with `baseHashRef` already pointing at the new
      // disk hash, and the conflict classifier below would read that mismatch as "changed on
      // disk" and raise a banner for a save that actually succeeded.
      onNameChange(savedAs)
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
    // Both actions end in text landing in the buffer, whose only destinations are a save and a
    // draft — and a read-only pane has neither. The buttons are disabled too; this covers the
    // keyboard and any future command surface that does not go through them.
    if (readOnly) return
    const myRun = ++runId.current
    setBusy(true)
    setPhase(which)
    setError(null)
    // `lastSaved === null` for the same reason `renameCreate` needs it: `onSave` moves
    // `baselineRef` to the saved content, so an equality-only check reads "untouched" again after
    // a save — and this branch decides whether to write the model's output straight into the
    // document or route it through the review diff. Getting it wrong here replaces saved work
    // with generated text and never shows the user a diff. The previous increment used a monotone
    // `bufferPristine` flag that a save never reset; this restores that meaning.
    const wasUntouched = lastSaved === null && docRef.current === baselineRef.current
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
    dropDraft(filedAsRef.current)
    const disk = await readAsset(kind, filedAsRef.current)
    if (!liveRef.current) return
    setBanner({ kind: 'none' })
    if (disk) {
      baseHashRef.current = disk.hash
      applyContent(disk.content, disk.content)
    } else if (mode === 'create') {
      // A create-mode draft has no file on disk to fall back to. Reseed the template, as
      // Increment 2 did via its remount — without this the drafted text stays on screen, the
      // pane stays dirty against it, and the very next keystroke files the draft that was just
      // discarded.
      const seeded = template(name)
      baseHashRef.current = null
      applyContent(seeded, seeded)
    } else {
      // Edit mode with nothing readable. `readAsset` swallows every error to null, so this is a
      // transient IPC failure as often as a deleted asset — either way, say so rather than
      // leaving the pane silently half-resolved.
      setError(`Could not re-read ${kind} "${filedAsRef.current}".`)
    }
    // Increment 2 had to unmount the editor before these awaits, because a keystroke landing
    // mid-flight would be silently reverted by the remount that followed. That hazard is gone:
    // this is a transaction, so anything typed in the gap is one Ctrl+Z away rather than lost.
  }, [kind, mode, name, template, applyContent, dropDraft])

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
        // and the pane is genuinely clean. Dropped *before* `applyContent`, so the re-entrant
        // equality check inside `handleDocChange` sees `draftFiled` already false and does not
        // discard a second time.
        dropDraft(filedAsRef.current)
        applyContent(next.content, next.content)
      } else {
        // Keep mine: the text does not move, but the draft file on disk still carries the
        // pre-resolution `baseHash`. Left alone, the next reopen would compare that stale hash
        // against disk and re-ask a question the user already answered — so re-file it against
        // the new hash. `draftAt` is untouched: only `onDraftSaved` may claim a draft is kept.
        fileDraft({
          name: filedAsRef.current,
          content: next.content,
          baseHash: next.baseHash
        })
      }
    },
    [applyContent, dropDraft, fileDraft]
  )

  /**
   * Spec §4.4: no fs watcher — external changes are noticed here and at save.
   *
   * Only the **active** tab listens. Every tab stays mounted (spec §6.1 as built), so an
   * unconditional listener would fire one `readAsset` per open tab on every window focus — which
   * is the cost §4.4 rejected a watcher to avoid, multiplied by the tab count. A tab you cannot
   * see does not need its banner yet, so `active` is also in the dependency array: becoming
   * active runs the check once, catching anything missed while hidden.
   *
   * `check()` is called directly in the effect body, not via `setState` — it dispatches an async
   * IPC read and only ever calls `setState` inside a `.then`, so `react-hooks/set-state-in-effect`
   * is satisfied. Do not hoist the `setBanner` out of the async callback.
   */
  useEffect(() => {
    if (!active) return
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
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [kind, active, applyContent])

  // Read once, at mount — same discipline as `docRef`/`baselineRef` above, and for a sharper
  // reason here: the next task plugs in the *live* per-tab view state, which updates on every
  // cursor move. Keeping this prop in the effect's dependency array would re-run `requestMeasure`
  // on every keystroke; capturing it into a ref that is never reassigned drops it from the
  // dependency list without losing the value the restore below needs.
  const initialViewStateRef = useRef(initialViewState)

  // Applied on first activation rather than at mount: a display-none view has no geometry, so a
  // scroll or a `goToLine` issued at mount lands nowhere. This is also where the tab picks up
  // the layout it could not compute while hidden.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!active) return
    surfaceRef.current?.requestMeasure()
    const view = initialViewStateRef.current
    if (restoredRef.current || !view) return
    restoredRef.current = true
    surfaceRef.current?.goToLine(view.line, {
      col: view.col,
      focus: false
    })
    // Imperative, NOT the `scrollFraction` prop's state setter: a synchronous setState in an
    // effect body trips `react-hooks/set-state-in-effect`, which this repo forbids suppressing.
    surfaceRef.current?.scrollTo(view.scrollFraction)
  }, [active])

  // Resumable-drafts banner (Increment 5 pulled forward). Keying create-mode drafts by a stable
  // id (rather than the typed name) makes the silent-overwrite half of the original defect
  // impossible outright — two create drafts sharing a name now coexist on disk — so there is no
  // collision to warn about here any more, only drafts to offer back.
  const resumeDraft = (d: DraftRecord): void => {
    // `draftId` carries a modern draft's identity forward so the resumed tab finds it by id. Its
    // absence here means a legacy record (predates draft ids, still keyed by kind+name) — the
    // resumed tab's mount-time fallback (see AssetTab's resolve effect) picks it up by name
    // instead and adopts it onto a freshly minted id.
    void window.argus.editor.open({
      kind,
      name: d.name,
      mode: 'create',
      ...(d.draftId ? { draftId: d.draftId } : {})
    })
  }

  const compare =
    compareSnapshot !== null && (banner.kind === 'stale' || banner.kind === 'conflict')
      ? { disk: banner.disk, snapshot: compareSnapshot }
      : null
  // Anything that takes the editor's place on screen. Both keep the surface **mounted** (see the
  // wrapper below): unmounting CodeMirror discards undo history and cursor position on top of
  // the text, which is Increment 2's Finding 1 with higher stakes. Preview mode is not an
  // overlay here — `EditorPane` hides the surface itself, in-place, while keeping it in this tree.
  const overlay = compare !== null || proposed !== null

  // Spec §5.5. `dirty` is in the condition as well as `draftAt` because the draft write is
  // debounced ~500ms in main: between the keystroke and `onDraftSaved`, the file genuinely is
  // not saved, and claiming Saved would be a lie in exactly the window where it matters. `Draft`
  // without a time reads as "pending", which is what it is — persist-before-adopt is preserved,
  // because only `onDraftSaved` ever supplies the timestamp.
  const sync: SyncState =
    banner.kind === 'conflict' || banner.kind === 'stale'
      ? 'conflict'
      : draftAt !== null || dirty
        ? 'draft'
        : 'saved'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hair bg-hi px-4 py-2.5">
        <span className="truncate font-mono text-xs text-dim">
          {kind === 'skill' ? 'skills' : 'references'} / {name}
        </span>
        <span className="flex items-center gap-2">
          <Btn
            variant="ghost"
            disabled={proposed !== null}
            onClick={() => setViewMode(nextViewMode(prefs.viewMode))}
          >
            {prefs.viewMode === 'editor'
              ? 'Split'
              : prefs.viewMode === 'split'
                ? 'Preview'
                : 'Edit'}
          </Btn>
          <Btn
            variant="primary"
            disabled={busy || proposed !== null || readOnly}
            onClick={() => void onSave()}
          >
            Save
          </Btn>
        </span>
      </div>

      {mode === 'create' && (
        <div className="flex items-center gap-2 border-b border-hair bg-hi px-4 py-2">
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
          {proposed === null && prefs.viewMode !== 'preview' && (
            <Btn
              variant="outline"
              disabled={busy || !describe.trim() || provider?.ok === false || readOnly}
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

      {mode === 'create' && otherDrafts.length > 0 && (
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
              <Btn key={d.draftId ?? d.name} variant="ghost" onClick={() => resumeDraft(d)}>
                {d.name}
              </Btn>
            ))}
          </span>
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
        <EditorPane
          viewMode={prefs.viewMode}
          splitFraction={prefs.splitFraction}
          onSplitFraction={(splitFraction) => {
            writePrefs({ splitFraction })
            setPrefs((p) => ({ ...p, splitFraction }))
          }}
          surface={
            <CodeSurface
              ref={surfaceRef}
              initialDoc={initialDoc}
              ariaLabel={`${kind} · ${initialName}`}
              issues={issues}
              fontSize={prefs.fontSize}
              wrap={prefs.wrap}
              commands={commands}
              readOnly={readOnly}
              onDocChange={handleDocChange}
              onCursor={handleCursor}
              onScrollFraction={handleScrollFraction}
            />
          }
          preview={<PreviewPane doc={doc} scrollFraction={editorFraction} />}
        />
        <ProblemsPanel
          issues={issues}
          open={problemsOpen}
          onToggle={() => setProblemsOpen((o) => !o)}
          onGoToLine={(line) => surfaceRef.current?.goToLine(line)}
        />
        <div className="flex items-center justify-end gap-2 border-t border-hair bg-hi px-4 py-2">
          <span className="flex shrink-0 items-center gap-2">
            {provider && (
              <span className={`text-xs ${provider.ok ? 'text-faint' : 'text-danger'}`}>
                {provider.ok ? provider.text : provider.reason}
              </span>
            )}
            <Btn
              variant="outline"
              disabled={busy || !doc.trim() || provider?.ok === false || readOnly}
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

      <StatusBar
        cursor={cursor}
        issues={issues}
        sync={sync}
        draftAt={draftAt}
        viewMode={prefs.viewMode}
        tier={tier}
        onProblems={() => setProblemsOpen((o) => !o)}
        onCycleViewMode={() => setViewMode(nextViewMode(prefs.viewMode))}
      />
    </div>
  )
}
