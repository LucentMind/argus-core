import { useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { setDiagnostics } from '@codemirror/lint'
import {
  baseExtensions,
  fontSizeCompartment,
  fontSizeTheme,
  readOnlyCompartment,
  readOnlyExtension,
  wrapCompartment
} from './extensions/setup'
import { editorKeymap, type SurfaceCommands } from './extensions/keymap'
import { partitionIssues } from '../../lib/diagnostics'
import { scrollFractionOf } from '../../lib/scrollSync'
import type { CursorInfo, SurfaceHandle } from './surface'
import type { ValidationIssue } from '../../../../shared/assetValidation'

export interface CodeSurfaceProps {
  /** Read **once, at mount**. Spec §5.2: React never re-sets the document from a prop — that is
   *  what destroys undo history (defect §1.1.1). To show a different asset, remount with a new
   *  `key`; to change this one's text, call `setDoc` on the handle. */
  initialDoc: string
  /** `${kind} · ${name}`, the same convention the textarea used, so the CDP gates keep one way
   *  to find the editing surface. */
  ariaLabel: string
  issues: ValidationIssue[]
  fontSize: number
  wrap: boolean
  commands: SurfaceCommands
  onDocChange: (doc: string) => void
  onCursor: (info: CursorInfo) => void
  /** Fires on scroll, as a 0–1 fraction, for the split preview's scroll sync. Output only —
   *  scrolling the surface TO a fraction is `SurfaceHandle.scrollTo`, not a prop. */
  onScrollFraction?: (fraction: number) => void
  /**
   * **Live**, not mount-only — reconfigured through `readOnlyCompartment` whenever it changes.
   *
   * This reverses an earlier decision ("no `Compartment` needed: a read-only buffer has no undo
   * history to preserve"), whose premise was that `readOnly` is known at mount. It is not. It is
   * derived from `skills:list` / `refsync:get`, so a protected asset routinely mounts with the
   * tier still unresolved, the predicate failing open, and the buffer **editable** — and applying
   * the later `true` only at mount left the banner and the disabled Save sitting over a fully
   * typable document. It also runs the other way: after a claim, `replaceTab` re-derives this
   * from a tier map that has not yet seen `refsync:changed`, so the pane can mount read-only and
   * has to be released when the broadcast lands.
   *
   * A compartment is what makes both directions safe: it reconfigures without rebuilding the
   * view, so the document, undo history and cursor survive the flip even if the user has already
   * typed. Do **not** replace it with a remount under a new React `key`.
   */
  readOnly?: boolean
  ref?: React.Ref<SurfaceHandle>
}

/**
 * The CodeMirror 6 wrapper (spec §5.1, §5.2). Hand-rolled on purpose: the third-party React
 * wrappers abstract away exactly the behaviour being fixed here — how an external value change
 * reaches the document.
 *
 * The view is built in a mount effect with an empty dependency array and torn down in its
 * cleanup. Under dev-mode StrictMode (`editor.tsx` wraps the tree in it) that runs twice —
 * build, destroy, build — which is correct and harmless here **only because** nothing outside
 * this effect holds a reference to the first view: `viewRef` is overwritten by the second build,
 * and the imperative handle reads `viewRef.current` at call time rather than closing over a
 * view. Do not "optimise" the handle to capture the view directly.
 */
export function CodeSurface({
  initialDoc,
  ariaLabel,
  issues,
  fontSize,
  wrap,
  commands,
  onDocChange,
  onCursor,
  onScrollFraction,
  readOnly = false,
  ref
}: CodeSurfaceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // The callbacks are read through refs so a parent re-render (which produces new function
  // identities on every render) never rebuilds the view. Rebuilding would discard undo history
  // and cursor position on every keystroke — the mirror below sets React state, so every
  // keystroke *is* a parent re-render.
  const onDocChangeRef = useRef(onDocChange)
  const onCursorRef = useRef(onCursor)
  const onScrollRef = useRef(onScrollFraction)
  useEffect(() => {
    onDocChangeRef.current = onDocChange
    onCursorRef.current = onCursor
    onScrollRef.current = onScrollFraction
  }, [onDocChange, onCursor, onScrollFraction])

  const commandsRef = useRef(commands)
  useEffect(() => {
    commandsRef.current = commands
  }, [commands])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          ...baseExtensions({ fontSize, wrap, readOnly }),
          editorKeymap(commandsRef),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onDocChangeRef.current(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              const { main } = update.state.selection
              const line = update.state.doc.lineAt(main.head)
              onCursorRef.current({
                line: line.number,
                col: main.head - line.from + 1,
                selected: Math.abs(main.to - main.from)
              })
            }
          })
        ]
      })
    })
    viewRef.current = view

    const scroller = view.scrollDOM
    const report = (): void => {
      onScrollRef.current?.(scrollFractionOf(scroller))
    }
    scroller.addEventListener('scroll', report, { passive: true })

    return () => {
      scroller.removeEventListener('scroll', report)
      view.destroy()
      viewRef.current = null
    }
    // Mount-only. `initialDoc`, `ariaLabel` and the initial font size / wrap / readOnly are
    // seeds, not live inputs: the first two change only across a remount (the parent keys on
    // the asset/tab), and the last three are reconfigured through their compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(
    ref,
    (): SurfaceHandle => ({
      getDoc: () => viewRef.current?.state.doc.toString() ?? initialDoc,
      setDoc: (text) => {
        const view = viewRef.current
        if (!view) return
        // One transaction over the whole document: undoable in a single Ctrl+Z, which is the
        // entire point of defect §1.1.1's fix.
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      },
      goToLine: (line, opts) => {
        const view = viewRef.current
        if (!view) return
        // Text.line THROWS out of range rather than clamping, so every caller's line number has
        // to be clamped here — a diagnostic on a line the user has since deleted is routine.
        // `Number.isFinite` first, for the same reason `scrollTo` below guards its fraction: the
        // restored view state comes out of a persisted JSON file, which is untrusted input, and
        // NaN slips straight through the clamp (both `NaN < 1` and `NaN > lines` are false) and
        // on past `Text.line`'s own range check into undefined behaviour.
        const n = Number.isFinite(line)
          ? Math.min(Math.max(1, Math.trunc(line)), view.state.doc.lines)
          : 1
        const info = view.state.doc.line(n)
        // Same guard on the column, which arrives from the same persisted file: a NaN survives
        // both `Math.max` and `Math.min` and reaches `dispatch` as an invalid selection anchor.
        // `Math.trunc` too, symmetric with `line` above — a fractional `col` (e.g. `2.5`) would
        // otherwise produce a fractional `pos` that still passes CodeMirror's range check and
        // reaches `dispatch({ selection: { anchor } })` as an invalid, non-integer anchor.
        const rawCol = opts?.col ?? 1
        const col = Number.isFinite(rawCol) ? Math.trunc(rawCol) : 1
        const pos = Math.min(info.from + Math.max(0, col - 1), info.to)
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
        if (opts?.focus !== false) view.focus()
      },
      focus: () => viewRef.current?.focus(),
      requestMeasure: () => viewRef.current?.requestMeasure(),
      scrollTo: (fraction) => {
        const view = viewRef.current
        if (!view) return
        const scroller = view.scrollDOM
        const span = scroller.scrollHeight - scroller.clientHeight
        // Clamped: a fraction from a persisted file is untrusted input, and a NaN here would
        // silently leave the scroller at 0 rather than throwing anywhere visible.
        const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0
        scroller.scrollTop = span > 0 ? span * f : 0
      }
    }),
    [initialDoc]
  )

  // Diagnostics are pushed, not pulled. `setDiagnostics` self-configures the lint state field
  // (verified against @codemirror/lint 6.9.7 — it works with only `lintGutter()` present, and
  // even with no lint extension at all), so there is no `linter()` source and no ~750ms debounce
  // between a validation error appearing and its marker showing up.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const { placed } = partitionIssues(issues, view.state.doc)
    view.dispatch(setDiagnostics(view.state, placed))
  }, [issues])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontSizeCompartment.reconfigure(fontSizeTheme(fontSize))
    })
  }, [fontSize])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : [])
    })
  }, [wrap])

  // The tier that decides this arrives asynchronously, so this is a real reconfiguration and not
  // a no-op after mount — see the prop's doc comment.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(readOnly))
    })
  }, [readOnly])

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
}
