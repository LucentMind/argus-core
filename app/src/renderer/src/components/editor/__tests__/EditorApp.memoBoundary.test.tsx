// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorApp } from '../EditorApp'
import type { SurfaceHandle } from '../surface'
import type { AssetTabProps } from '../AssetTab'
import type { EditorOpenRequest } from '../../../../../shared/editorIpc'

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
 * Finding 1's reproduction rig. `renderCounts` is keyed by the asset name each `AssetTab` mount
 * was given, and incremented by a thin wrapper that otherwise delegates straight to the real
 * component — so this instruments exactly what the reviewer's own spy did (a render-count on
 * `AssetTab`) without changing anything about its behaviour. Every other test file that imports
 * `EditorApp` leaves `../AssetTab` unmocked; this one file's mock only ever ADDS counting, so it
 * cannot be the reason any assertion here passes or fails.
 */
const renderCounts: Record<string, number> = {}
vi.mock('../AssetTab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AssetTab')>()
  const CountedAssetTab = (props: AssetTabProps): React.JSX.Element => {
    renderCounts[props.req.name] = (renderCounts[props.req.name] ?? 0) + 1
    return <actual.AssetTab {...props} />
  }
  return { ...actual, AssetTab: CountedAssetTab }
})

let openTab: ((req: EditorOpenRequest) => void) | null = null

beforeEach(() => {
  openTab = null
  for (const k of Object.keys(renderCounts)) delete renderCounts[k]
  window.argus = {
    editor: {
      open: vi.fn(),
      onOpenTab: (cb: (req: EditorOpenRequest) => void) => {
        openTab = cb
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
      corpus: vi.fn().mockResolvedValue([]),
      tabsChanged: vi.fn(),
      onRestoreTabs: () => () => {}
    },
    skills: {
      // Every name gets frontmatter that matches itself, so both tabs opened below pass
      // validation and neither Save is blocked — a fixed single-name fixture would leave the
      // second-opened tab failing `validateSkill`'s name-match check for reasons unrelated to
      // what this file is testing.
      read: vi.fn().mockImplementation(async (name: string) => ({
        content: `---\nname: ${name}\ndescription: Use when testing.\n---\n\n# hi\n`,
        hash: 'h1'
      })),
      write: vi.fn().mockResolvedValue({ skills: [], hash: 'h1-new' }),
      list: vi.fn().mockResolvedValue({ skills: [] }),
      onChanged: () => () => {},
      fork: vi.fn()
    },
    refsync: {
      readRef: vi.fn().mockResolvedValue({ content: '# ref\n', hash: 'h2' }),
      writeRef: vi.fn().mockResolvedValue('h2-new'),
      get: vi.fn().mockResolvedValue({ config: {}, loadError: null, cards: [], references: [] }),
      onChanged: () => () => {}
    },
    hivemind: {
      claimReference: vi.fn()
    }
  } as never
})

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }
const OTHER: EditorOpenRequest = { kind: 'skill', name: 'other-skill', mode: 'edit' }

// Finding 1: `TabPane`'s `.map` call site used to hand EVERY tab the same, per-keystroke-rebuilt
// `commands` array, so `TabPane`'s own `memo` saw a changed prop on every mounted tab — active or
// not — and bailed out of skipping the re-render for all of them. A keystroke in the tab on
// screen has no business reaching a tab the user cannot even see.
describe('TabPane memo boundary', () => {
  it('does not re-render an inactive tab when the active tab is typed into', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    // OTHER was opened second, so it is the active tab and MY-SKILL is now the inactive,
    // hidden one — exactly the tab this test watches.
    const activeArea = await screen.findByLabelText('skill · other-skill')
    // Both panes report their own initial `PaneCommandState` back to `EditorApp` the moment they
    // mount (an unavoidable, self-triggered re-render each — see the report effect in
    // AssetPane.tsx), and switching the active tab is itself one legitimate re-render for
    // `my-skill` (`active` genuinely flips false). None of that is the defect under test, so the
    // baseline is taken AFTER it all settles, not assumed to be a fixed number.
    await act(async () => {})

    const beforeInactive = renderCounts['my-skill']
    const beforeActive = renderCounts['other-skill']

    await userEvent.type(activeArea, 'x')

    // The active tab is expected to re-render (that is the whole point of it being live) — this
    // assertion exists so the test cannot pass merely because nothing re-rendered anywhere.
    expect(renderCounts['other-skill']).toBeGreaterThan(beforeActive)
    // The regression: the INACTIVE tab must not move at all.
    expect(renderCounts['my-skill']).toBe(beforeInactive)
  })
})
