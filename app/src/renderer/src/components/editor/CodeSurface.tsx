import { useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { setDiagnostics } from '@codemirror/lint'
import {
  baseExtensions,
  fontSizeCompartment,
  fontSizeTheme,
  wrapCompartment
} from './extensions/setup'
import { editorKeymap, type SurfaceCommands } from './extensions/keymap'
import { partitionIssues } from '../../lib/diagnostics'
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
  /** Fires on scroll, as a 0–1 fraction, for the split preview's scroll sync. */
  onScrollFraction?: (fraction: number) => void
  /** Scroll to this fraction when it changes and the change did not come from here. */
  scrollFraction?: number
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
  scrollFraction,
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

  /** Set while this component is applying an incoming `scrollFraction`, so the scroll event it
   *  causes is not reported straight back out as user scrolling — which would make the two panes
   *  chase each other. */
  const applyingScroll = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          ...baseExtensions({ fontSize, wrap }),
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
      if (applyingScroll.current) return
      const range = scroller.scrollHeight - scroller.clientHeight
      onScrollRef.current?.(range > 0 ? scroller.scrollTop / range : 0)
    }
    scroller.addEventListener('scroll', report, { passive: true })

    return () => {
      scroller.removeEventListener('scroll', report)
      view.destroy()
      viewRef.current = null
    }
    // Mount-only. `initialDoc`, `ariaLabel` and the initial font size / wrap are seeds, not live
    // inputs: the first two change only across a remount (the parent keys on the asset), and the
    // last two are reconfigured through their compartments below.
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
      goToLine: (line) => {
        const view = viewRef.current
        if (!view) return
        // Clamped for the same reason `partitionIssues` clamps: the line can outrun a document
        // that shrank, and `doc.line()` throws rather than saturating.
        const n = Math.min(Math.max(1, line), view.state.doc.lines)
        const pos = view.state.doc.line(n).from
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' })
        })
        view.focus()
      },
      focus: () => viewRef.current?.focus()
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

  useEffect(() => {
    const view = viewRef.current
    if (!view || scrollFraction === undefined) return
    const scroller = view.scrollDOM
    const range = scroller.scrollHeight - scroller.clientHeight
    if (range <= 0) return
    applyingScroll.current = true
    scroller.scrollTop = scrollFraction * range
    // Cleared on the next frame, not synchronously: the scroll event this assignment queues is
    // dispatched asynchronously, so clearing the flag now would let it through and start the
    // two panes chasing each other.
    requestAnimationFrame(() => {
      applyingScroll.current = false
    })
  }, [scrollFraction])

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
}
