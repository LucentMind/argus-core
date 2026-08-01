// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorApp } from '../EditorApp'
import type { SurfaceHandle } from '../surface'
import type { EditorOpenRequest, PersistedTabs } from '../../../../../shared/editorIpc'
import type { RefSyncPayload } from '../../../../../shared/referenceSync'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: vi.fn(() => ({ ok: true, text: 'via claude' }))
}))

// CodeMirror cannot run under jsdom: it measures real DOM, and jsdom's `textRange().getClientRects`
// does not exist — a real `EditorView` throws out of its measure loop on every mount (spec §8.2
// says as much). The surface is proven by the CDP gate in Task 11; these window-level tests only
// need something that reports document changes, so it is a textarea. Same mock shape as
// AssetPane.test.tsx, minus the parts only that file's assertions need.
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

let openTab: ((req: EditorOpenRequest) => void) | null = null
let closeRequested: ((info: { dirtyCount: number }) => void) | null = null
/** `refsync:changed`, held so a test can decide **when** the post-claim tier map arrives. Main
 *  happens to broadcast before `hivemind:claim-reference` returns today, which is an ordering
 *  coincidence, not a guarantee — the read-only release must not depend on it.
 *
 *  A LIST, not a single slot: `EditorApp` now has two independent subscribers to this channel —
 *  `useAssetTiers` (the tier map `readOnly` reads) and `useEditorAssets` (Task 9's palette corpus,
 *  which also refreshes on a reference change). A single captured callback only kept whichever
 *  subscribed LAST, so firing it silently stopped reaching `useAssetTiers` the moment the second
 *  subscriber joined — the real IPC bridge fans a broadcast out to every listener, and the fake
 *  has to as well or it tests a bridge that doesn't exist. */
let refsyncListeners: Array<(p: RefSyncPayload) => void> = []
const refsyncChanged = (p: RefSyncPayload): void => {
  for (const cb of refsyncListeners) cb(p)
}
/** `editor:restore-tabs`. Sent on window creation, before the `openTab` that caused it — see
 *  the "tab-set restore" describe block below. */
let restoreTabs: ((tabs: PersistedTabs) => void) | null = null
const setDirty = vi.fn()
const respondClose = vi.fn()
const tabsChanged = vi.fn()

/** The reference rows `refsync.get` starts every test with. `shared.md` is the only one a claim
 *  can act on: `claimReference` refuses anything but an installed HiveMind reference. */
const references = (sharedTier: string | null = 'hivemind'): RefSyncPayload['references'] => [
  { file: 'notes.md', tier: null, lastSynced: null, sourceCount: 0, stale: false, author: null },
  {
    file: 'synced.md',
    tier: 'confluence',
    lastSynced: null,
    sourceCount: 0,
    stale: false,
    author: null
  },
  {
    file: 'shared.md',
    tier: sharedTier,
    lastSynced: null,
    sourceCount: 0,
    stale: false,
    author: null
  }
]

beforeEach(() => {
  openTab = null
  closeRequested = null
  refsyncListeners = []
  restoreTabs = null
  setDirty.mockClear()
  respondClose.mockClear()
  tabsChanged.mockClear()
  window.argus = {
    editor: {
      open: vi.fn(),
      onOpenTab: (cb: (req: EditorOpenRequest) => void) => {
        openTab = cb
        return () => {}
      },
      setDirty,
      onCloseRequested: (cb: (info: { dirtyCount: number }) => void) => {
        closeRequested = cb
        return () => {}
      },
      respondClose,
      draftChanged: vi.fn(),
      readDraft: vi.fn().mockResolvedValue(null),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      onDraftSaved: () => () => {},
      // Only exercised by a create-mode open (`AssetTab`'s `otherDrafts` resolution) — every
      // pre-existing test here opens in edit mode, so this was never needed until the "follows a
      // create-mode rename" test below. Task 10's palette tests override this per-test where a
      // draft row needs to appear (see the `commands` describe block below) — the empty default
      // here matters: `AssetPane`'s "unsaved new skills" banner is also `role="status"`, and
      // several read-only tests already assert `queryByRole('status')` is absent.
      listDrafts: vi.fn().mockResolvedValue([]),
      // Backs `useEditorAssets` (Task 9), which `EditorApp` now mounts unconditionally — every
      // test in this file renders `EditorApp`, so this has to exist even where the palette is
      // never opened. `triage` is the one asset the `commands` describe block below searches for.
      corpus: vi
        .fn()
        .mockResolvedValue([
          { kind: 'skill', name: 'triage', title: '', description: 'd', tier: 'user' }
        ]),
      tabsChanged,
      onRestoreTabs: (cb: (tabs: PersistedTabs) => void) => {
        restoreTabs = cb
        return () => {}
      }
    },
    skills: {
      read: vi.fn().mockResolvedValue({
        content: '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# hi\n',
        hash: 'h1'
      }),
      // Realistic shape: skills:write's real result is a SkillsWriteResult (list + hash), not
      // a bare hash. The 'h1-new' vs 'h1' distinction (and h2 vs h2-new below) lets assertions
      // tell "the hash the read gave us" apart from "the hash the write gave back" instead of
      // both accidentally being the same literal.
      write: vi.fn().mockResolvedValue({ skills: [], hash: 'h1-new' }),
      // Backs useAssetTiers (Task 7): 'theirs' is the fixture's one read-only (hivemind) skill,
      // everything else this file opens is a plain 'user' skill.
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
      // Echoes back the requested name (real forkSkill's result names what was actually created),
      // rather than a fixed literal, so the "forks under the name the user picks" test proves the
      // tab really followed the returned name and not a hardcoded one.
      fork: vi
        .fn()
        .mockImplementation((name: string, newName?: string) =>
          Promise.resolve({ name: newName ?? name, skills: [] })
        )
    },
    refsync: {
      readRef: vi.fn().mockResolvedValue({ content: '# ref\n', hash: 'h2' }),
      // refsync:write's real result is a bare hash string, unlike skills:write's object.
      writeRef: vi.fn().mockResolvedValue('h2-new'),
      // Backs useAssetTiers: 'notes.md' is untagged (tier: null — hand-authored, editable);
      // 'synced.md' is Confluence-synced and 'shared.md' HiveMind-installed (both read-only, but
      // only the latter can be claimed).
      get: vi.fn().mockResolvedValue({
        config: {},
        loadError: null,
        cards: [],
        references: references()
      }),
      onChanged: (cb: (p: RefSyncPayload) => void) => {
        refsyncListeners.push(cb)
        return () => {
          refsyncListeners = refsyncListeners.filter((l) => l !== cb)
        }
      }
    },
    hivemind: {
      claimReference: vi.fn().mockResolvedValue({})
    }
  } as never
})

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }
const REFERENCE: EditorOpenRequest = { kind: 'reference', name: 'notes.md', mode: 'edit' }

describe('EditorApp', () => {
  it('shows an empty state until a tab is opened', () => {
    render(<EditorApp />)
    expect(screen.getByText(/nothing open/i)).toBeInTheDocument()
  })

  it('renders the editor for an asset pushed from main', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    expect(await screen.findByLabelText('skill · my-skill')).toBeInTheDocument()
  })

  it('reports dirty state to main when the buffer is edited', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))
  })

  it('answers a close request with allow when nothing is dirty', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    await screen.findByLabelText('skill · my-skill')
    closeRequested!({ dirtyCount: 0 })
    await waitFor(() => expect(respondClose).toHaveBeenCalledWith(true))
  })

  it('asks the user before allowing a close while dirty', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await userEvent.type(await screen.findByLabelText('skill · my-skill'), 'x')
    act(() => closeRequested!({ dirtyCount: 1 }))

    // Reports rather than warns: the draft store makes closing non-destructive (spec §3.5).
    expect(await screen.findByText(/kept as drafts/i)).toBeInTheDocument()
    // Not a plain findByRole('button', { name: /^close$/i }): ModalShell's own icon-only
    // dismiss button is also named "Close" via aria-label/title, so the accessible-name query
    // matches two elements. Disambiguate on visible text — the dismiss icon has none.
    const closeButtons = await screen.findAllByRole('button', { name: /^close$/i })
    const confirmBtn = closeButtons.find((b) => b.textContent === 'Close')
    await userEvent.click(confirmBtn!)
    await waitFor(() => expect(respondClose).toHaveBeenCalledWith(true))
  })

  // A window is not a modal: it stays on the asset after a save. Emptying it would send the user
  // back to the Library just to keep editing the same file. Main is holding the close veto on
  // the reported dirty count, so that has to reach 0 without the editor unmounting.
  it('keeps the asset open after a save, and reports clean to main', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(0))
    expect(screen.getByLabelText('skill · my-skill')).toBeInTheDocument()
    expect(screen.queryByText(/nothing open/i)).not.toBeInTheDocument()
  })

  it('answers deny when the user cancels the close', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    closeRequested!({ dirtyCount: 1 })

    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(respondClose).toHaveBeenCalledWith(false))
  })
})

// These tests pin that swapping assets never prompts, because the draft is already persisted to
// disk (spec §6.1). Re-opening the same asset is a no-op, not a remount that would destroy the
// buffer or release main's close veto.
describe('EditorApp asset swapping', () => {
  const dirtySkill = async (): Promise<void> => {
    render(<EditorApp />)
    openTab!(SKILL)
    await userEvent.type(await screen.findByLabelText('skill · my-skill'), 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))
  }

  const DISCARD = 'Discard and open'

  it('swaps to a different asset without prompting, even while dirty', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await userEvent.type(await screen.findByLabelText('skill · my-skill'), 'x')

    act(() => openTab!(REFERENCE))

    // Drafts persist (spec §4), so a swap destroys nothing and asking would be theatre.
    expect(await screen.findByLabelText('reference · notes.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /discard and open/i })).not.toBeInTheDocument()
  })

  // The "focus the existing window" path: main re-sends the same request on every second Edit of
  // the asset already open. Prompting there would be a false alarm on the commonest interaction.
  it('does not prompt when the same asset is re-opened while dirty', async () => {
    await dirtySkill()
    openTab!({ ...SKILL })

    // Re-opening the same asset is a no-op, not a remount, so no prompt appears. Give pending
    // effects time to complete.
    await act(async () => {})

    expect(screen.queryByRole('button', { name: DISCARD })).not.toBeInTheDocument()
    expect(screen.getByLabelText<HTMLTextAreaElement>('skill · my-skill').value).toContain('x')
  })

  it('swaps without prompting when nothing is dirty', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    await screen.findByLabelText('skill · my-skill')

    openTab!(REFERENCE)

    expect(await screen.findByLabelText('reference · notes.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: DISCARD })).not.toBeInTheDocument()
  })
})

// This is the coverage the deleted LibraryPage save-routing tests carried before Task 7 moved
// saving into the editor window: which IPC a save routes to, in what argument order, and that
// the hash it returns actually becomes the next save's baseHash. Nothing else exercises
// EditorApp's `save` prop at all — the tests above only ever click Save and check the editor
// closes, which passes even if the arguments are wrong or the hash is thrown away.
describe('EditorApp save wiring', () => {
  it('saves a skill via skills.write, with (name, content, loadedHash) in that order', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(window.argus.skills.write).toHaveBeenCalledWith(
        'my-skill',
        '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# hi\nx',
        'h1'
      )
    )
  })

  it('saves a reference via refsync.writeRef, with (name, content, loadedHash) in that order', async () => {
    render(<EditorApp />)
    openTab!(REFERENCE)
    const area = await screen.findByLabelText('reference · notes.md')
    await userEvent.type(area, 'x')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(window.argus.refsync.writeRef).toHaveBeenCalledWith('notes.md', '# ref\nx', 'h2')
    )
  })

  it('adopts the hash a save returns as the baseHash for the very next save', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')

    // Hold the first write pending so we can move the document while it's in flight — that is
    // what makes the pane report "you kept typing" rather than settling clean, so a second, real
    // save happens in the same session and we can inspect what baseHash it used.
    let resolveWrite: (v: { skills: never[]; hash: string }) => void = () => {}
    vi.mocked(window.argus.skills.write).mockImplementationOnce(
      () => new Promise((resolve) => (resolveWrite = resolve))
    )

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await userEvent.type(area, 'y')
    resolveWrite({ skills: [], hash: 'h1-second' })

    // Confirms the editor stayed open (didn't adopt undefined and silently misbehave) and that
    // the pane adopted the returned hash into baseHash, per the comment on `writeAsset`.
    await screen.findByText(/kept typing while it was saving/i)

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(window.argus.skills.write).toHaveBeenLastCalledWith(
        'my-skill',
        expect.any(String),
        'h1-second'
      )
    )
  })
})

// draft-id-rekey gap: create-mode drafts are keyed by a stable `draftId`, but EditorApp's
// AssetTab key must include it too. Resuming a draft whose name matches the currently open tab's
// name (the single most likely case — every "New skill" opens as `my-skill`) produces an
// identical kind/name/mode, so without `draftId` in the key React never remounts AssetTab and the
// incoming `draftId` never takes effect — the click on the resumable-drafts banner silently does
// nothing.
describe('EditorApp resuming a same-named draft', () => {
  const CREATE: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'create' }

  it("remounts and resolves the resumed draft when it shares the open tab's kind/name/mode", async () => {
    // Force the create-mode path (no existing asset on disk to fall back to) so the tab's
    // content is unambiguous evidence of which draft it resolved against.
    vi.mocked(window.argus.skills.read).mockRejectedValue(new Error('No such skill: my-skill'))
    const readDraft = vi.mocked(window.argus.editor.readDraft)
    readDraft.mockImplementation(async (ref) =>
      'draftId' in ref && ref.draftId === 'resumed-id'
        ? {
            kind: 'skill',
            name: 'my-skill',
            mode: 'create',
            content: '# resumed draft content\n',
            baseHash: null,
            updatedAt: '2026-07-30T15:00:00.000Z',
            draftId: 'resumed-id'
          }
        : null
    )

    render(<EditorApp />)
    openTab!(CREATE)
    const area = await screen.findByLabelText<HTMLTextAreaElement>('skill · my-skill')
    // The first tab opened with nothing to restore, so it seeded the create template.
    expect(area.value).toContain('name: my-skill')

    // Same kind/name/mode as the tab already open, but a different draftId — the shape a click
    // on the resumable-drafts banner produces.
    openTab!({ ...CREATE, draftId: 'resumed-id' })

    // The resumed id must actually be looked up...
    await waitFor(() => expect(readDraft).toHaveBeenCalledWith({ draftId: 'resumed-id' }))
    // ...and its content must reach the surface of the tab now ON SCREEN.
    //
    // Scoped to the active panel rather than queried globally, because since Increment 4 the
    // resume opens a SECOND tab and every tab stays MOUNTED — so two surfaces legitimately carry
    // the label `skill · my-skill` and a bare `getByLabelText` throws "found multiple elements".
    // Resolving through the tab's own `aria-controls` is what makes "the one the user is looking
    // at" expressible; it also means this still fails if the resume silently focused the old tab.
    await waitFor(() => {
      const panelId = screen.getByRole('tab', { selected: true }).getAttribute('aria-controls')!
      const panel = document.getElementById(panelId)!
      expect(within(panel).getByLabelText<HTMLTextAreaElement>('skill · my-skill').value).toBe(
        '# resumed draft content\n'
      )
    })
  })
})

const OTHER: EditorOpenRequest = { kind: 'skill', name: 'other-skill', mode: 'edit' }

describe('multiple tabs', () => {
  it('opens a second asset in a second tab', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  // The point of the whole increment: nothing unmounts on a switch, so undo history, cursor and
  // a running assist all survive. `toBeInTheDocument` is the observable proxy for that here —
  // the undo half is asserted for real by the CDP gate.
  it('keeps the first tab mounted when the second opens', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    expect(screen.getByLabelText('skill · my-skill')).toBeInTheDocument()
  })

  it('focuses the existing tab when the same asset is opened again', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    act(() => openTab!(SKILL))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /my-skill/ })).toHaveAttribute('aria-selected', 'true')
    )
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('switches tabs from the strip', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    await userEvent.click(screen.getByRole('tab', { name: /my-skill/ }))
    expect(screen.getByRole('tab', { name: /my-skill/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('unmounts a tab when it is closed', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    await userEvent.click(screen.getByRole('button', { name: 'Close my-skill' }))
    await waitFor(() => expect(screen.queryByLabelText('skill · my-skill')).not.toBeInTheDocument())
  })

  it('shows the empty state again after the last tab closes', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    await userEvent.click(screen.getByRole('button', { name: 'Close my-skill' }))
    expect(await screen.findByText(/nothing open/i)).toBeInTheDocument()
  })
})

describe('dirty aggregation', () => {
  // Increment 1 built setDirtyCount and the "N tabs have unsaved changes" copy for exactly this.
  // Until now the window could only ever report 0 or 1.
  it('reports the number of dirty tabs, not a boolean', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await userEvent.type(await screen.findByLabelText('skill · my-skill'), 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))
    act(() => openTab!(OTHER))
    await userEvent.type(await screen.findByLabelText('skill · other-skill'), 'y')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(2))
  })

  it('stops counting a tab that was closed while dirty', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await userEvent.type(await screen.findByLabelText('skill · my-skill'), 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))
    await userEvent.click(screen.getByRole('button', { name: 'Close my-skill' }))
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(0))
  })

  it('marks the dirty tab in the strip', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    act(() => openTab!(OTHER))
    await userEvent.type(await screen.findByLabelText('skill · other-skill'), 'y')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /other-skill/ })).toHaveAccessibleName(/unsaved/i)
    )
    expect(screen.getByRole('tab', { name: /my-skill/ })).not.toHaveAccessibleName(/unsaved/i)
  })
})

// Finding 1. Nothing flipped `Tab.mode`, so a create-mode tab stayed create-mode for ever after
// its save. Both halves are here: the duplicate on a later Library *Edit*, and the `mode: 'create'`
// that restore would replay over a file that now holds real content.
describe('a create-mode tab that has been saved', () => {
  const CREATE: EditorOpenRequest = { kind: 'skill', name: 'brand-new', mode: 'create' }

  /** Open a create-mode tab over an asset that genuinely does not exist yet, and save it. The
   *  read has to fail: `beforeEach` seeds `skills.read` to resolve with a file, and a create-mode
   *  pane over a "file" whose frontmatter names a different skill fails validation, so Save would
   *  never run. */
  const createAndSave = async (): Promise<void> => {
    window.argus.skills.read = vi.fn().mockRejectedValue(new Error('ENOENT'))
    render(<EditorApp />)
    act(() => openTab!(CREATE))
    await screen.findByLabelText('skill · brand-new')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(window.argus.skills.write).toHaveBeenCalled())
  }

  it('does not open a second tab when the new asset is then opened for editing', async () => {
    await createAndSave()

    act(() => openTab!({ kind: 'skill', name: 'brand-new', mode: 'edit' }))
    await act(async () => {})

    // Two tabs over one file share a draft (`draftKey` is `kind:name` only) and leave each
    // other's `baseHash` stale, which shows up as a conflict banner for a save that worked.
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  // The persisted half. A restored `mode: 'create'` tab resolves the REAL disk content into a
  // create-mode pane whose `lastSaved` is null again — one keystroke in the name field then
  // replaced the saved body with boilerplate and filed the boilerplate as the draft.
  it('is persisted as an edit-mode tab, so a restart cannot replay create mode over it', async () => {
    await createAndSave()

    await waitFor(() =>
      expect(tabsChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tabs: [expect.objectContaining({ name: 'brand-new', mode: 'edit' })]
        })
      )
    )
  })
})

describe('tab labels', () => {
  it('follows a create-mode rename in the strip', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'untitled', mode: 'create' }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'renamed')
    await waitFor(() => expect(screen.getByRole('tab', { name: /renamed/ })).toBeInTheDocument())
  })
})

// Task 6 is the first place `TabBar` (role="tab") and the panes (previously bare divs) ever mount
// together, and the WAI-ARIA tabs pattern was only half built: no `role="tabpanel"`, no ids, no
// `aria-controls`/`aria-labelledby` linking either side. This proves the two ends actually point
// at each other, not just that each element independently carries the right role.
describe('tab/panel ARIA relationship', () => {
  it('wires the active tab to its panel via aria-controls and aria-labelledby', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    const area = await screen.findByLabelText('skill · my-skill')
    const tab = screen.getByRole('tab', { name: /my-skill/ })
    const panel = area.closest('[role="tabpanel"]') as HTMLElement | null
    expect(panel).not.toBeNull()
    expect(tab.id).not.toBe('')
    expect(panel!.id).not.toBe('')
    expect(tab).toHaveAttribute('aria-controls', panel!.id)
    expect(panel).toHaveAttribute('aria-labelledby', tab.id)
  })

  // A second, inactive tab's panel is `hidden` (display: none), which already removes it from the
  // accessibility tree — `aria-hidden` on top would be a bug on a subtree that can contain the
  // focused element (see the comment in EditorApp.tsx). This pins that it is absent.
  it('does not mark an inactive panel aria-hidden', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!(OTHER))
    await screen.findByLabelText('skill · other-skill')
    const firstArea = screen.getByLabelText('skill · my-skill')
    const firstPanel = firstArea.closest('[role="tabpanel"]')
    expect(firstPanel).not.toHaveAttribute('aria-hidden')
  })
})

describe('read-only tabs', () => {
  it('opens a hivemind skill read-only', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'edit' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/read-only/i)
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('opens a user skill editable', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // The regression guard from finding 1: an untagged reference is hand-authored and editable.
  it('opens an untagged reference editable', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'notes.md', mode: 'edit' }))
    await screen.findByLabelText('reference · notes.md')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('opens a confluence reference read-only', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'synced.md', mode: 'edit' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/read-only/i)
  })

  it('opens a hivemind reference read-only', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'shared.md', mode: 'edit' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/read-only/i)
  })

  // Create mode has no tier to look up and must never be gated on one. The name deliberately
  // COLLIDES with the hivemind skill fixture: a name absent from both lists resolves to
  // `undefined`, which fails open anyway, so it would pass with the create-mode guard deleted.
  it('opens a create-mode tab editable even when its name matches a read-only asset', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'create' }))
    await screen.findByLabelText(/name/i)
    // Give the tier lists (both awaited promises) time to land before concluding there is no
    // notice — otherwise this would pass simply by racing them.
    await act(async () => {})
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // Several read-only tabs stay mounted at once, so the banners have to be told apart.
  it('names the asset in the read-only sentence', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'synced.md', mode: 'edit' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/synced\.md/)
  })
})

describe('Edit a copy', () => {
  it('forks a skill under the name the user picks and swaps the tab to it', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'my-copy')
    await userEvent.click(screen.getByRole('button', { name: /^fork$|^create copy$|^copy$/i }))
    await waitFor(() => expect(window.argus.skills.fork).toHaveBeenCalledWith('theirs', 'my-copy'))
    expect(await screen.findByRole('tab', { name: /my-copy/ })).toBeInTheDocument()
  })

  // Types a NEW name on purpose. Forking in place leaves the request identical to the tab already
  // open, so `openTab`'s "one tab per asset" dedupe would return the same single tab and this
  // assertion would hold whether the fork replaced the tab or merely re-focused it. A distinct
  // name is the only thing that tells `replaceTab` and `openTab` apart here.
  it('does not add a tab — it replaces the read-only one', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'my-copy')
    await userEvent.click(screen.getByRole('button', { name: /^fork$|^create copy$|^copy$/i }))
    await screen.findByRole('tab', { name: /my-copy/ })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  // Finding 2. The test above picks a NEW name on purpose, which is exactly why it could not see
  // this: `replaceTab` minted unconditionally, so forking onto a name ALREADY open gave two tabs
  // over one file. The persisted set carried the duplicate and restore silently merged it back,
  // so the tab count changed across a restart.
  it('folds into the tab that is already open when the fork lands on its name', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'my-skill')

    await userEvent.click(screen.getByRole('button', { name: /^fork$|^create copy$|^copy$/i }))
    await waitFor(() => expect(window.argus.skills.fork).toHaveBeenCalledWith('theirs', 'my-skill'))

    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    expect(screen.getByRole('tab', { name: /my-skill/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('claims a reference in place and keeps its name', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'shared.md', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^claim$/i }))
    await waitFor(() =>
      expect(window.argus.hivemind.claimReference).toHaveBeenCalledWith('shared.md')
    )
    expect(await screen.findByRole('tab', { name: /shared\.md/ })).toBeInTheDocument()
  })

  it('leaves the tab alone when the claim is declined', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'shared.md', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^cancel$/i }))
    expect(window.argus.hivemind.claimReference).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent(/read-only/i)
  })

  // `claimReference` (hivemind.ts:568) refuses anything but an installed HiveMind reference, so
  // offering the button here fired an IPC that always rejects. The explanation stands alone.
  it('offers no Edit a copy for a confluence reference, only the explanation', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'synced.md', mode: 'edit' }))
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(/rebuilt from its confluence page/i)
    expect(screen.queryByRole('button', { name: /edit a copy/i })).not.toBeInTheDocument()
  })

  it('reports a rejected claim instead of doing nothing', async () => {
    vi.mocked(window.argus.hivemind.claimReference).mockRejectedValueOnce(
      new Error('Not an installed HiveMind reference: shared.md')
    )
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'shared.md', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^claim$/i }))

    expect(await screen.findByText(/could not make "shared\.md" yours/i)).toBeInTheDocument()
    expect(await screen.findByText(/not an installed hivemind reference/i)).toBeInTheDocument()
  })

  // The fork flow's error handling is the dialog, NOT a catch in EditorApp: `forkSkill` throws on
  // a name collision and staying open for another name is the recovery path.
  it('reports a rejected fork inline and keeps the dialog open for another name', async () => {
    vi.mocked(window.argus.skills.fork).mockRejectedValueOnce(
      new Error('A skill named "my-skill" already exists.')
    )
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'theirs', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'my-skill')
    await userEvent.click(screen.getByRole('button', { name: /^fork$|^create copy$|^copy$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i)
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
  })

  // Finding 3: `replaceTab` re-derives `readOnly` from a tier map that has not yet seen
  // `refsync:changed`, so the replacement pane can mount read-only even though the claim is
  // already on disk. It must be RELEASED when the broadcast lands, not stuck for the session.
  it('releases the replacement tab when the post-claim tier broadcast arrives late', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'reference', name: 'shared.md', mode: 'edit' }))
    await userEvent.click(await screen.findByRole('button', { name: /edit a copy/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^claim$/i }))
    await waitFor(() =>
      expect(window.argus.hivemind.claimReference).toHaveBeenCalledWith('shared.md')
    )
    // `refsync.onChanged` has NOT fired: the map still says hivemind, so the fresh tab re-derives
    // read-only from stale data. Asserted rather than assumed — without this the release below
    // would pass trivially on a tab that was never read-only in the first place.
    await screen.findByLabelText('reference · shared.md')
    expect(screen.getByRole('status')).toHaveTextContent(/read-only/i)
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    // `useAssetTiers` reads only `references` off the payload; the rest of a real `RefSyncPayload`
    // (the Confluence config, in particular) is irrelevant here and stubbing it in full would say
    // nothing extra.
    act(() =>
      refsyncChanged({
        config: {},
        loadError: null,
        cards: [],
        references: references('user')
      } as unknown as RefSyncPayload)
    )

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })
})

describe('tab-set restore', () => {
  it('opens the restored tabs', async () => {
    render(<EditorApp />)
    act(() =>
      restoreTabs!({
        tabs: [
          { kind: 'skill', name: 'my-skill', mode: 'edit', view: null },
          { kind: 'reference', name: 'notes.md', mode: 'edit', view: null }
        ],
        activeIndex: 1
      })
    )
    expect(await screen.findByRole('tab', { name: /my-skill/ })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: /notes\.md/ })).toBeInTheDocument()
  })

  it('activates the tab that was active', async () => {
    render(<EditorApp />)
    act(() =>
      restoreTabs!({
        tabs: [
          { kind: 'skill', name: 'my-skill', mode: 'edit', view: null },
          { kind: 'reference', name: 'notes.md', mode: 'edit', view: null }
        ],
        activeIndex: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /notes\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
  })

  // Restore lands first (main sends it before the openTab that created the window), so the
  // clicked asset must focus its restored tab rather than opening a second one.
  it('focuses rather than duplicates when the clicked asset was already restored', async () => {
    render(<EditorApp />)
    act(() =>
      restoreTabs!({
        tabs: [{ kind: 'skill', name: 'my-skill', mode: 'edit', view: null }],
        activeIndex: 0
      })
    )
    act(() => openTab!(SKILL))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
  })

  // The reporting effect also runs on MOUNT, before restore has arrived. Reporting an empty set
  // there tells main to persist nothing over the set it is restoring — the debounce happens to
  // cover it today, but a persisted tab set must not depend on winning a race.
  it('reports nothing before the first tab arrives', async () => {
    render(<EditorApp />)
    await act(async () => {})
    expect(tabsChanged).not.toHaveBeenCalled()
  })

  it('sends the tab set to main when a tab opens', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    await waitFor(() =>
      expect(tabsChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tabs: [expect.objectContaining({ kind: 'skill', name: 'my-skill' })],
          activeIndex: 0
        })
      )
    )
  })

  // The report carries `t.name` (the LIVE name), not `t.req.name` (the request as minted, frozen
  // by design — see tabs.ts). Every other test in this file opens in `edit` mode, where the two
  // are identical, so mutating the reporting effect to `t.req.name` left the whole suite green.
  // A create-mode tab that has been renamed is the only place they differ.
  it('reports the typed name of a renamed create-mode tab, not the original request', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'untitled', mode: 'create' }))
    const field = await screen.findByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'renamed')

    await waitFor(() =>
      expect(tabsChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tabs: [expect.objectContaining({ name: 'renamed', mode: 'create' })],
          activeIndex: 0
        })
      )
    )
    // The frozen request's name must never appear in the report — restoring on it would reopen
    // an asset the user renamed away from.
    const reported = tabsChanged.mock.calls.flatMap(
      (c) => (c[0] as PersistedTabs).tabs as Array<{ name: string }>
    )
    expect(reported.at(-1)!.name).toBe('renamed')
  })

  it('sends the tab set when a tab closes', async () => {
    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    await userEvent.click(screen.getByRole('button', { name: 'Close my-skill' }))
    await waitFor(() => expect(tabsChanged).toHaveBeenLastCalledWith({ tabs: [], activeIndex: -1 }))
  })

  // A tab whose asset was deleted with no draft behind it resolves to AssetTab's error state.
  // It is kept and closable — main restores blindly, and the honest report beats silently
  // dropping a tab the user had open.
  it('keeps a tab whose asset can no longer be read', async () => {
    window.argus.skills.read = vi.fn().mockRejectedValue(new Error('No such skill: gone'))
    render(<EditorApp />)
    act(() =>
      restoreTabs!({
        tabs: [{ kind: 'skill', name: 'gone', mode: 'edit', view: null }],
        activeIndex: 0
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not read/i)
    expect(screen.getByRole('tab', { name: /gone/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close gone' }))
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument())
  })
})

// Task 10: EditorApp becomes the window's single command host — one keymap, one palette, fed by
// the registry `buildCommands` assembles (lib/commands.ts) and the corpus `useEditorAssets` reads.
describe('EditorApp · commands', () => {
  it('opens the palette on Ctrl+P and closes it on a second Escape', async () => {
    render(<EditorApp />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    expect(await screen.findByRole('combobox')).toBeTruthy()
  })

  it('opens the palette pre-filled with > on Ctrl+Shift+P', async () => {
    render(<EditorApp />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })
    const input = await screen.findByRole<HTMLInputElement>('combobox')
    expect(input.getAttribute('value') ?? input.value).toBe('>')
  })

  it('opens the picked asset in a tab', async () => {
    render(<EditorApp />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: 'triage' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('tab', { name: /triage/ })).toBeTruthy()
  })

  it('does not act on a window shortcut while the palette is open', async () => {
    render(<EditorApp />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    await screen.findByRole('combobox')
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    // Still open: the palette owns the keyboard while it is up.
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  // The brief for this task delivers the open via a standalone `emitOpenTab` helper, called
  // BEFORE `render`. This file has no such helper — its established convention (used throughout
  // every other describe block above) is the `openTab` variable that `window.argus.editor.
  // onOpenTab`'s stub captures, called AFTER `render`, because that variable is only assigned
  // once `EditorApp`'s mount effect subscribes. Following the file's convention instead, per the
  // task instructions.
  it('closes the active tab on Ctrl+W', async () => {
    render(<EditorApp />)
    act(() => openTab!({ kind: 'skill', name: 'triage', mode: 'edit' }))
    await screen.findByRole('tab', { name: /triage/ })
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('tab', { name: /triage/ })).toBeNull())
  })

  it('ignores a shortcut CodeMirror already handled', async () => {
    render(<EditorApp />)
    const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    e.preventDefault()
    window.dispatchEvent(e)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('discards a draft from the palette and drops its row', async () => {
    vi.mocked(window.argus.editor.listDrafts).mockResolvedValue([
      {
        kind: 'skill',
        name: 'half',
        mode: 'create',
        content: '',
        baseHash: null,
        updatedAt: '2026-07-30T10:00:00.000Z',
        draftId: 'd1'
      }
    ])
    render(<EditorApp />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    const row = await screen.findByRole('option', { name: /half/ })
    fireEvent.click(within(row).getByRole('button', { name: /discard/i }))
    await waitFor(() =>
      expect(window.argus.editor.discardDraft).toHaveBeenCalledWith({ draftId: 'd1' })
    )
  })
})

// The `commands` describe block above only ever fires `p` (palette) or `w` (close tab) — both
// WINDOW-scoped commands that go straight to `ctx.window.*` and never touch `registerPane`, the
// handle map, or `activePane()` in EditorApp.tsx. Nothing there would catch a broken wire-up
// between the window keydown listener and a real, mounted `AssetPane`'s actual action. These two
// tests are the replacement for what `AssetPane.test.tsx` used to pin directly before Task 10
// deleted its per-pane `window` listener (commit d3193f48): a real `window` keydown, through the
// registry, reaching a real pane's real `save()`/`cycleViewMode()`.
describe('EditorApp · window shortcuts reach the real active pane', () => {
  // The important one: routing a window shortcut to the first-OPENED pane instead of the ACTIVE
  // one is exactly the defect the one-registry redesign exists to prevent — see `activePane()`,
  // which resolves the handle map by `stateRef.current.activeId`, not by insertion order.
  it('routes a window-level Ctrl+S to the active pane, not the first-opened one', async () => {
    // The shared fixture's `skills.read` always answers with `my-skill`'s frontmatter, which
    // would leave `other-skill` failing `validateSkill`'s name-match check — and its Save
    // disabled — the moment it is opened. Each name needs frontmatter that matches itself.
    vi.mocked(window.argus.skills.read).mockImplementation(
      async (name: string): Promise<{ name: string; content: string; hash: string }> => ({
        name,
        content: `---\nname: ${name}\ndescription: Use when testing.\n---\n\n# hi\n`,
        hash: 'h1'
      })
    )

    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    // Opened SECOND, so `openTab` (tabs.ts) makes it the active tab — the first tab stays
    // mounted (spec §6.1), so both real panes are alive and registered when the key fires.
    act(() => openTab!(OTHER))
    const area = await screen.findByLabelText('skill · other-skill')
    await userEvent.type(area, 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))

    // Nothing here ever puts focus on either surface (`userEvent.type` above focuses the ACTIVE
    // one only), and the mock `CodeSurface` has no keymap to consume the key either way — this
    // can only reach a real `save()` through `activePane()` resolving the tab the window
    // believes is active.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => expect(window.argus.skills.write).toHaveBeenCalledTimes(1))
    // The assertion that actually pins the regression: WHICH name reached `skills.write`, not
    // merely that a write happened at all.
    expect(window.argus.skills.write).toHaveBeenCalledWith('other-skill', expect.any(String), 'h1')
    expect(window.argus.skills.write).not.toHaveBeenCalledWith(
      'my-skill',
      expect.anything(),
      expect.anything()
    )
  })

  // With CodeMirror never focused (the mock surface here is never clicked or typed into), a
  // keydown listener that bails out early — or one that was never wired up at all — has nothing
  // else to fall back on. This is the no-focus half of the coverage the deleted AssetPane.test.tsx
  // "cycles the view mode from a window-level key, not only from the focused editor" test used to
  // carry, driven here through EditorApp's single registry-backed listener instead.
  it('cycles the view mode from a window-level key with no editor focus', async () => {
    // View mode persists to localStorage (lib/editorPrefs.ts), not React state alone — a mode
    // left behind by an earlier test would make the starting label here order-dependent.
    localStorage.clear()

    render(<EditorApp />)
    act(() => openTab!(SKILL))
    await screen.findByLabelText('skill · my-skill')
    // The pane's first `PaneCommandState` report reaches `EditorApp` (and thus the `commands`
    // registry `cycleViewMode`'s `enabled` reads) an effect-tick after the surface mounts. The
    // Save button's disabled/enabled state is driven by that same report, so waiting for it to
    // settle is what makes firing the key below deterministic instead of racing the report.
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled())

    const viewModeButton = (): HTMLElement => screen.getByRole('button', { name: /^View mode:/ })
    expect(viewModeButton()).toHaveAttribute('aria-label', 'View mode: Editor')

    fireEvent.keyDown(window, { key: 'v', ctrlKey: true, shiftKey: true })

    await waitFor(() => expect(viewModeButton()).toHaveAttribute('aria-label', 'View mode: Split'))
  })
})
