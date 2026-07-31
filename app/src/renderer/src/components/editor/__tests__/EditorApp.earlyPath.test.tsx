// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { SurfaceHandle } from '../surface'
import type { EditorOpenRequest, PersistedTabs } from '../../../../../shared/editorIpc'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: vi.fn(() => ({ ok: true, text: 'via claude' }))
}))

// Same reason as EditorApp.test.tsx: CodeMirror measures real DOM and cannot run under jsdom.
interface MockSurfaceProps {
  initialDoc: string
  ariaLabel: string
  onDocChange: (doc: string) => void
  ref?: { current: SurfaceHandle | null }
}
vi.mock('../CodeSurface', () => ({
  CodeSurface: ({
    initialDoc,
    ariaLabel,
    onDocChange,
    ref
  }: MockSurfaceProps): React.JSX.Element => {
    if (ref) {
      ref.current = {
        getDoc: () => initialDoc,
        setDoc: (text: string) => onDocChange(text),
        goToLine: vi.fn(),
        focus: vi.fn(),
        requestMeasure: vi.fn(),
        scrollTo: vi.fn(),
        openGotoLine: vi.fn()
      }
    }
    return (
      <textarea
        aria-label={ariaLabel}
        defaultValue={initialDoc}
        onChange={(e) => onDocChange(e.target.value)}
      />
    )
  }
}))

/**
 * The EARLY path, which every other EditorApp test structurally cannot reach.
 *
 * `EditorApp.test.tsx` installs `window.argus` in `beforeEach` — after its static import of
 * `EditorApp` (and therefore of `editorBootstrap`) has already evaluated. So the bridge is absent
 * at module scope there, and every one of those tests runs the LATE fallback, where messages are
 * delivered straight to a live sink in arrival order. The bug this file exists for only exists in
 * the buffered case: messages that arrive BEFORE any React effect has run, and are replayed
 * afterwards.
 *
 * That is the production case, not a corner case. Main flushes its whole send queue synchronously
 * at `did-finish-load`, which can precede React's passive effects.
 *
 * Everything here therefore installs the bridge FIRST and imports `EditorApp` with a dynamic
 * import, so `editorBootstrap`'s module-scope subscriptions bind to these stubs.
 */
let emitOpen: ((req: EditorOpenRequest) => void) | null = null
let emitRestore: ((tabs: PersistedTabs) => void) | null = null
const tabsChanged = vi.fn()

function installBridge(): void {
  emitOpen = null
  emitRestore = null
  tabsChanged.mockClear()
  window.argus = {
    editor: {
      open: vi.fn(),
      onOpenTab: (cb: (req: EditorOpenRequest) => void) => {
        emitOpen = cb
        return () => {}
      },
      setDirty: vi.fn(),
      onCloseRequested: () => () => {},
      respondClose: vi.fn(),
      draftChanged: vi.fn(),
      readDraft: vi.fn().mockResolvedValue(null),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      onDraftSaved: () => () => {},
      listDrafts: vi.fn().mockResolvedValue([]),
      tabsChanged,
      onRestoreTabs: (cb: (tabs: PersistedTabs) => void) => {
        emitRestore = cb
        return () => {}
      }
    },
    skills: {
      read: vi.fn().mockResolvedValue({ content: '# hi\n', hash: 'h1' }),
      write: vi.fn().mockResolvedValue({ skills: [], hash: 'h1-new' }),
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            name: 'my-skill',
            tier: 'user',
            description: '',
            enabled: true,
            shadows: [],
            shadowDiverged: false,
            author: null
          },
          {
            name: 'other-skill',
            tier: 'user',
            description: '',
            enabled: true,
            shadows: [],
            shadowDiverged: false,
            author: null
          },
          {
            name: 'theirs',
            tier: 'hivemind',
            description: '',
            enabled: true,
            shadows: [],
            shadowDiverged: false,
            author: null
          }
        ]
      }),
      onChanged: () => () => {},
      fork: vi.fn()
    },
    refsync: {
      readRef: vi.fn().mockResolvedValue({ content: '# ref\n', hash: 'h2' }),
      writeRef: vi.fn().mockResolvedValue('h2-new'),
      get: vi.fn().mockResolvedValue({
        config: {},
        loadError: null,
        cards: [],
        references: []
      }),
      onChanged: () => () => {}
    },
    hivemind: {
      claimReference: vi.fn().mockResolvedValue({})
    }
  } as never
}

/** Fresh module graph per test, so `editorBootstrap`'s module-scope subscription re-binds to the
 *  bridge this test installed rather than a previous test's. */
async function importEditorApp(): Promise<() => React.JSX.Element> {
  const mod = await import('../EditorApp')
  return mod.EditorApp
}

const CLICKED: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }

/** Exactly what main persists and replays: three tabs, with `theirs` active at exit. */
const RESTORED: PersistedTabs = {
  tabs: [
    { kind: 'skill', name: 'other-skill', mode: 'edit', view: null },
    { kind: 'skill', name: 'theirs', mode: 'edit', view: null },
    { kind: 'skill', name: 'my-skill', mode: 'edit', view: null }
  ],
  activeIndex: 1
}

describe('EditorApp early (buffered) path', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as { argus?: unknown }).argus
    installBridge()
  })

  /**
   * The regression this task's review found. Main sends `restoreTabs` then the `openTab` that
   * caused the window's creation, through ONE queue, flushed in one synchronous pass — so both
   * land before React has mounted anything. Replayed correctly, the restored ORDER survives and
   * the clicked asset is merely focused inside it (the renderer dedupes on open).
   *
   * Against the two-buffer implementation this replaced, the queued `openTab` was applied first
   * (its effect was declared first), giving `["my-skill","other-skill","theirs"]` with
   * `"other-skill"` selected — `next.tabs[activeIndex]` indexing an array the open had already
   * shifted. Both assertions below fail there, and the corruption is self-perpetuating: the
   * reporting effect persists the mangled order straight back to main.
   */
  it('applies a buffered restore before a buffered open, preserving order and selection', async () => {
    const EditorApp = await importEditorApp()

    // Main's flush order at `did-finish-load`, before any React effect has run.
    emitRestore!(RESTORED)
    emitOpen!(CLICKED)

    render(<EditorApp />)

    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'other-skill',
      'theirs',
      'my-skill'
    ])
    // The clicked asset, not the one restore made active and not the one at the stale index.
    expect(screen.getByRole('tab', { name: /^skill · my-skill/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  // The mangled order does not merely display wrong — it is reported straight back to main and
  // persisted, so a single bad restore poisons every later restart.
  it('reports the restored order to main, not a reordered one', async () => {
    const EditorApp = await importEditorApp()

    emitRestore!(RESTORED)
    emitOpen!(CLICKED)

    render(<EditorApp />)

    await waitFor(() => expect(tabsChanged).toHaveBeenCalled())
    const last = tabsChanged.mock.calls.at(-1)![0] as PersistedTabs
    expect(last.tabs.map((t) => t.name)).toEqual(['other-skill', 'theirs', 'my-skill'])
    expect(last.tabs[last.activeIndex].name).toBe('my-skill')
  })

  // Without a module-scope subscription the buffered messages have no listener at all and the
  // window opens empty — the dropped-first-message bug Increment 1 fixed on the main side.
  it('does not drop a message that arrives before the component mounts', async () => {
    const EditorApp = await importEditorApp()

    emitOpen!(CLICKED)

    render(<EditorApp />)

    expect(await screen.findByRole('tab', { name: /^skill · my-skill/ })).toBeInTheDocument()
  })
})
