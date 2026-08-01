// @vitest-environment jsdom
import { StrictMode, createRef } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { AssetPane } from '../AssetPane'
import type { CursorInfo, SurfaceHandle } from '../surface'
import type { SurfaceCommands } from '../extensions/keymap'
import type { ValidationIssue } from '../../../../../shared/assetValidation'
import type { DraftSaved } from '../../../../../shared/editorIpc'
import type { AssetPaneHandle, Command } from '../../../lib/commands'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: () => ({ ok: true, text: 'claude · sonnet' })
}))

declare global {
  /** The mocked surface's document, shared between the component and the fake handle below. */
  var __doc: string | undefined
}

/**
 * `CodeSurface` is mocked, not rendered.
 *
 * Spec §8.2 is explicit that CodeMirror rendering is out of vitest's reach — it measures real
 * DOM and jsdom has no layout — and that the tests must not pretend otherwise by asserting on
 * CodeMirror internals. What *is* worth testing is everything around it: the draft gate, the
 * dirty derivation, the conflict verbs, the assist flow. So the mock is a textarea plus a real
 * implementation of `SurfaceHandle`, and the assertions are about which handle calls happen and
 * what gets sent to main. The surface itself is proven by the CDP gate in Task 11.
 */
const setDoc = vi.fn()
interface MockSurfaceProps {
  initialDoc: string
  ariaLabel: string
  issues: ValidationIssue[]
  commands: SurfaceCommands
  onDocChange: (doc: string) => void
  onCursor: (info: CursorInfo) => void
  onScrollFraction?: (fraction: number) => void
  readOnly?: boolean
  ref?: { current: SurfaceHandle | null }
}
/** The last props `AssetPane` rendered the surface with. Tests both assert on them (`readOnly`)
 *  and drive the pane through them, because the callbacks below are the only way to move the
 *  document, the cursor or the scroll position without a real CodeMirror. */
let surfaceProps: MockSurfaceProps = {} as MockSurfaceProps
/** The half of `SurfaceHandle` that is pure output — what the pane *did* to the surface.
 *  `getDoc`/`setDoc` stay implemented in the factory below, because other tests read them back. */
const surfaceHandle = {
  goToLine: vi.fn(),
  requestMeasure: vi.fn(),
  scrollTo: vi.fn(),
  focus: vi.fn(),
  openGotoLine: vi.fn()
}
vi.mock('../CodeSurface', () => ({
  CodeSurface: (props: MockSurfaceProps): React.JSX.Element => {
    surfaceProps = props
    const { initialDoc, ariaLabel, onDocChange, ref } = props
    if (ref) {
      ref.current = {
        ...surfaceHandle,
        getDoc: () => globalThis.__doc ?? initialDoc,
        setDoc: (text: string) => {
          setDoc(text)
          globalThis.__doc = text
          onDocChange(text)
        }
      }
    }
    globalThis.__doc ??= initialDoc
    return (
      <textarea
        aria-label={ariaLabel}
        defaultValue={initialDoc}
        onChange={(e) => {
          globalThis.__doc = e.target.value
          onDocChange(e.target.value)
        }}
      />
    )
  }
}))

const draftChanged = vi.fn()
const discardDraft = vi.fn()
const skillsWrite = vi.fn()
const skillsRead = vi.fn()
/** Captured so tests can fire the "bytes are on disk" confirmation themselves — see the
 *  status-bar-derivation tests below, which need to distinguish a pending draft from a dated one. */
let draftSavedListener: ((s: DraftSaved) => void) | undefined

const DISK = '---\nname: s\ndescription: d\n---\n\nbody\n'

beforeEach(() => {
  vi.clearAllMocks()
  surfaceProps = {} as MockSurfaceProps
  surfaceHandle.goToLine.mockClear()
  surfaceHandle.requestMeasure.mockClear()
  surfaceHandle.scrollTo.mockClear()
  surfaceHandle.focus.mockClear()
  surfaceHandle.openGotoLine.mockClear()
  // Implementations, not just call history: `vi.clearAllMocks()` leaves a previous test's
  // `mockRejectedValue`/`mockResolvedValue` in place, and every *active* pane now re-reads disk
  // the moment it mounts (spec §4.4's focus check, gated on `active`). A leaked implementation
  // would silently reload the buffer before the test's first keystroke. The default says what is
  // true of a freshly opened asset: disk holds exactly what the pane was mounted with.
  skillsRead.mockReset().mockResolvedValue({ content: DISK, hash: 'h1' })
  skillsWrite.mockReset().mockResolvedValue({ hash: 'h2' })
  // Task 7's view mode / split fraction persist to localStorage (`lib/editorPrefs.ts`), not to
  // React state alone — leaving a prior test's mode behind would make the Preview-button label
  // (and thus which click gets you where) order-dependent.
  localStorage.clear()
  globalThis.__doc = undefined
  draftSavedListener = undefined
  globalThis.window.argus = {
    editor: {
      draftChanged,
      discardDraft,
      onDraftSaved: (cb: (s: DraftSaved) => void) => {
        draftSavedListener = cb
        return () => {}
      }
    },
    skills: { read: skillsRead, write: skillsWrite },
    refsync: { readRef: vi.fn(), writeRef: vi.fn() },
    authoring: { draft: vi.fn(), improve: vi.fn() }
  } as never
})

function mount(
  overrides: Partial<React.ComponentProps<typeof AssetPane>> = {},
  /** `strict` wraps the tree in `<StrictMode>`, which double-invokes mount effects — the only
   *  way a test can see a mount-effect ref that is never re-armed. */
  opts: { strict?: boolean } = {}
): {
  onDirtyChange: ReturnType<typeof vi.fn>
  onNameChange: ReturnType<typeof vi.fn>
  onViewStateChange: ReturnType<typeof vi.fn>
  surface: HTMLElement
  rerender: (next: Partial<React.ComponentProps<typeof AssetPane>>) => void
} {
  const onDirtyChange = vi.fn()
  const onNameChange = vi.fn()
  const onViewStateChange = vi.fn()
  const props: React.ComponentProps<typeof AssetPane> = {
    kind: 'skill',
    initialName: 's',
    mode: 'edit',
    // Edit mode's identity is the file itself (see keyOf in main/services/drafts.ts) — the
    // create-mode-only tests below override this with a real id.
    draftId: '',
    initialDoc: DISK,
    initialBaseline: DISK,
    initialHash: 'h1',
    initialBanner: { kind: 'none' },
    initialDraftAt: null,
    otherDrafts: [],
    active: true,
    readOnly: false,
    tier: undefined,
    initialViewState: null,
    onDirtyChange,
    onNameChange,
    onViewStateChange,
    ...overrides
  }
  const tree = <AssetPane {...props} />
  const { rerender: rtlRerender } = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree)
  const rerender = (next: Partial<React.ComponentProps<typeof AssetPane>>): void => {
    const merged = <AssetPane {...props} {...next} />
    rtlRerender(opts.strict ? <StrictMode>{merged}</StrictMode> : merged)
  }
  // Derived, not the literal 'skill · s': the create-mode cases below mount under a different
  // name and the surface's aria-label follows it.
  return {
    onDirtyChange,
    onNameChange,
    onViewStateChange,
    surface: screen.getByLabelText(`${props.kind} · ${props.initialName}`),
    rerender
  }
}

/**
 * Task 7's command contract, spread over `AssetPaneProps` in the same shape `mount` above builds
 * by hand. Kept separate from `mount` rather than reused: those tests assert on `mount`'s return
 * shape (`surface`, `rerender`, the three callback mocks), while these only need `screen` and
 * whatever `paneRef`/`onCommandState` the caller passed in.
 */
function renderPane(overrides: Partial<React.ComponentProps<typeof AssetPane>> = {}): void {
  const props: React.ComponentProps<typeof AssetPane> = {
    kind: 'skill',
    initialName: 's',
    mode: 'edit',
    draftId: '',
    initialDoc: DISK,
    initialBaseline: DISK,
    initialHash: 'h1',
    initialBanner: { kind: 'none' },
    initialDraftAt: null,
    otherDrafts: [],
    active: true,
    readOnly: false,
    tier: undefined,
    initialViewState: null,
    onDirtyChange: vi.fn(),
    onNameChange: vi.fn(),
    onViewStateChange: vi.fn(),
    ...overrides
  }
  render(<AssetPane {...props} />)
}

/**
 * Arrange a save that is rejected because someone else wrote the file first.
 *
 * The concurrent edit lands *during* the save rather than before it, and that ordering is
 * load-bearing now: an active pane re-reads disk the moment it mounts (spec §4.4's check, gated
 * on `active` from Task 5). Pointing disk at a different hash up front would let that check
 * reload the clean buffer and adopt `h2` as the baseHash, after which the save's own comparison
 * finds nothing to conflict about. Driving it from inside the rejecting write is also immune to
 * how many times the check runs — StrictMode double-invokes the effect that owns it.
 */
function diskMovesDuringSave(): void {
  skillsWrite.mockImplementation(async () => {
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
    throw new Error('changed on disk')
  })
}

describe('AssetPane', () => {
  it('does not draft a file that was merely opened', async () => {
    mount()
    await waitFor(() => expect(screen.getByLabelText('skill · s')).toBeInTheDocument())
    expect(draftChanged).not.toHaveBeenCalled()
  })

  it('drafts the buffer once it diverges from the baseline', async () => {
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await waitFor(() => expect(draftChanged).toHaveBeenCalled())
    expect(draftChanged.mock.calls.at(-1)![0]).toMatchObject({
      kind: 'skill',
      name: 's',
      baseHash: 'h1'
    })
  })

  it('reports dirty only after the document leaves the baseline', async () => {
    const { onDirtyChange, surface } = mount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    await userEvent.type(surface, 'x')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })

  it('discards the draft when the user hand-reverts back to the baseline', async () => {
    const { onDirtyChange, surface } = mount()
    await userEvent.type(surface, 'X')
    await waitFor(() => expect(draftChanged).toHaveBeenCalled())
    await userEvent.type(surface, '{backspace}')
    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 's' }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('clears the restored-draft banner when the user hand-reverts to the baseline', async () => {
    // `handleDocChange`'s equality branch drops the draft, so without clearing the banner the
    // screen contradicts itself: the status bar reads Saved while a "Restored unsaved draft"
    // banner still offers a Discard button for a draft that no longer exists.
    const { surface } = mount({
      initialDoc: `${DISK}typed`,
      initialDraftAt: '2026-07-31T15:42:00.000Z',
      initialBanner: { kind: 'restored', updatedAt: '2026-07-31T15:42:00.000Z' }
    })
    expect(screen.getByText(/Restored unsaved draft/)).toBeInTheDocument()
    await userEvent.type(surface, '{backspace}{backspace}{backspace}{backspace}{backspace}')
    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 's' }))
    expect(screen.queryByText(/Restored unsaved draft/)).not.toBeInTheDocument()
  })

  it('does not touch the draft store when a merely-opened file is left alone', async () => {
    mount()
    await waitFor(() => expect(screen.getByLabelText('skill · s')).toBeInTheDocument())
    expect(draftChanged).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('opens a restored draft dirty, because a draft is unsaved work by definition', () => {
    const { onDirtyChange } = mount({
      initialDoc: `${DISK}typed`,
      initialBanner: { kind: 'restored', updatedAt: '2026-07-31T15:42:00.000Z' }
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('status')).toHaveTextContent('Restored unsaved draft')
  })

  it('routes an accepted assist proposal through setDoc, not through a value re-render', async () => {
    globalThis.window.argus.authoring.improve = vi.fn().mockResolvedValue({ content: 'PROPOSED' })
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: /improve/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    // The assertion that is really about defect §1.1.1: the accept goes through the handle (one
    // transaction) and never through a re-render of the surface with a new value. Undo itself is
    // CodeMirror's behaviour and is covered by the CDP gate, not by this.
    expect(setDoc).toHaveBeenCalledWith('PROPOSED')
  })

  it('keeps the surface mounted while an assist proposal is shown', async () => {
    globalThis.window.argus.authoring.improve = vi.fn().mockResolvedValue({ content: 'PROPOSED' })
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: /improve/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled())
    expect(surface).toBeInTheDocument()
  })

  it('keeps the surface mounted but inert while previewing', async () => {
    const { surface } = mount()
    // The header control is three-way now (Task 7): Editor -> Split -> Preview -> Edit. Two
    // clicks from the default 'editor' mode land on Preview.
    await userEvent.click(screen.getByRole('button', { name: 'Split' }))
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(surface).toBeInTheDocument()
    expect(surface.parentElement).toHaveAttribute('inert')
  })

  it('raises the conflict banner when a save is rejected because disk moved', async () => {
    diskMovesDuringSave()
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/saved version is newer/i)).toBeInTheDocument())
  })

  it('still raises the conflict banner under StrictMode double-invoked mount effects', async () => {
    // Restored from Increment 2. It guards a bug this repo has recorded as biting twice: a mount
    // effect that reuses the same ref across StrictMode's *simulated* cleanup leaves
    // `liveRef.current === false` for the component's entire real lifetime, so every guarded
    // async path silently takes its "unmounted" branch — here, the post-save conflict
    // classification, which would leave the user with no banner and no explanation. Only a
    // StrictMode-wrapped render can see it; the plain conflict test above passes either way, and
    // the app's real entry point (`editor.tsx`) does wrap the tree in StrictMode.
    diskMovesDuringSave()
    const { surface } = mount({}, { strict: true })
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/saved version is newer/i)).toBeInTheDocument())
  })

  it('ignores a second save while one is already in flight', async () => {
    let release: (v: { hash: string }) => void = () => {}
    skillsWrite.mockReturnValue(
      new Promise((r) => {
        release = r
      })
    )
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(skillsWrite).toHaveBeenCalledTimes(1))
    // The keyboard paths bypass the button's disabled state.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(skillsWrite).toHaveBeenCalledTimes(1)
    release({ hash: 'h2' })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('"Use disk" replaces the document through the handle and discards the draft', async () => {
    diskMovesDuringSave()
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/saved version is newer/i)).toBeInTheDocument())
    draftChanged.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Use disk' }))
    expect(setDoc).toHaveBeenLastCalledWith('OTHER')
    expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 's' })
    // The assertion that actually pins `applyContent`'s ordering contract. `setDoc` re-enters
    // `handleDocChange` synchronously; if the refs were written *after* the dispatch, that
    // re-entry would compare against the old baseline and file a draft for content the user
    // just chose to throw away. Without this line the test passes either way.
    expect(draftChanged).not.toHaveBeenCalled()
  })

  it('"Keep mine" keeps the text and re-files the draft against the new disk hash', async () => {
    diskMovesDuringSave()
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/saved version is newer/i)).toBeInTheDocument())
    draftChanged.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    // Not just "the draft survives": it must be re-filed against h2, or the next reopen compares
    // a stale baseHash against disk and asks the same question again.
    expect(draftChanged).toHaveBeenCalledWith(expect.objectContaining({ baseHash: 'h2' }))
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('keeps the surface mounted while Compare is up', async () => {
    diskMovesDuringSave()
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/saved version is newer/i)).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Compare' }))
    // Increment 2 Finding 1, carried forward and now stricter: unmounting the surface would
    // discard undo history and cursor position on top of the text.
    expect(surface).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'On disk compared with Yours' })).toBeInTheDocument()
  })

  it('blocks Save while validation has an error', async () => {
    mount({ initialDoc: 'no frontmatter', initialBaseline: 'no frontmatter' })
    // Not a click any more: Finding 2 fixed the toolbar fallback to agree with `buildCommands`
    // (`writable && !blocked`), so a blocked pane now correctly renders Save disabled — a real
    // click on a disabled button does nothing, which is exactly the coverage the
    // `toolbar fallback matches buildCommands` describe block below adds. What THIS test actually
    // pins is `onSave`'s own internal guard, which exists for the paths that ignore the button's
    // disabled attribute entirely — Ctrl+S through CodeMirror's keymap and the window-level
    // fallback (see the comment on `onSave` in AssetPane.tsx) — so it has to be driven through
    // that same handle, the way the read-only-panes block below already does for the same reason.
    act(() => surfaceProps.commands.save())
    expect(skillsWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/frontmatter/i)
  })

  it('carries the stable draftId (not a name-based re-key) when a create-mode name is edited', async () => {
    mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 'new-skill',
      initialDoc: 'seed',
      initialBaseline: 'seed'
    })
    await userEvent.type(screen.getByLabelText('skill name'), 'X')
    await waitFor(() => expect(draftChanged).toHaveBeenCalled())
    expect(draftChanged.mock.calls.at(-1)![0]).toMatchObject({
      name: 'new-skillX',
      draftId: 'draft-1'
    })
    // `replaces` no longer exists on the wire at all (see DraftChange in shared/editorIpc.ts) —
    // the draft's storage key never depended on the typed name, so there is nothing to route.
    expect(draftChanged.mock.calls.every((c) => !('replaces' in (c[0] as object)))).toBe(true)
  })

  it('reseeds the template when a create-mode draft is discarded', async () => {
    // Explicit, because `beforeEach` seeds `skillsRead` to resolve with a file — the default that
    // describes a freshly-opened asset — and a create-mode asset by definition has none on disk.
    skillsRead.mockRejectedValue(new Error('ENOENT'))
    mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 'new-skill',
      initialDoc: 'typed body',
      initialBaseline: 'seed',
      initialDraftAt: '2026-07-31T15:42:00.000Z',
      initialBanner: { kind: 'restored', updatedAt: '2026-07-31T15:42:00.000Z' }
    })
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    expect(setDoc.mock.calls.at(-1)![0]).toContain('name: new-skill')
    // Create mode discards by draftId, not by name — its storage key never depended on it.
    expect(discardDraft).toHaveBeenCalledWith({ draftId: 'draft-1' })
  })

  it('stops reporting dirty after a create-mode save, even with a Describe prompt typed', async () => {
    skillsWrite.mockResolvedValue({ hash: 'h2' })
    const { onDirtyChange } = mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 's',
      initialDoc: DISK,
      initialBaseline: DISK
    })
    await userEvent.type(screen.getByLabelText('describe it'), 'a thing')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('does not regenerate the template when a create-mode asset is renamed after saving', async () => {
    // `onSave` moves the baseline to the saved content, so an equality-only "untouched" check
    // flips back to true after a save and the next name keystroke wipes the saved body.
    skillsWrite.mockResolvedValue({ hash: 'h2' })
    const { surface } = mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 's',
      initialDoc: DISK,
      initialBaseline: DISK
    })
    await userEvent.type(surface, 'real body text')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(skillsWrite).toHaveBeenCalled())
    setDoc.mockClear()
    await userEvent.type(screen.getByLabelText('skill name'), 'X')
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('routes a Draft result through the diff once the asset has been saved', async () => {
    // Same bug family as the post-save rename: after a save the baseline equals the document
    // again, so an equality-only "untouched" check would land generated text straight over the
    // saved body with no diff to accept or discard.
    skillsWrite.mockResolvedValue({ hash: 'h2' })
    globalThis.window.argus.authoring.draft = vi.fn().mockResolvedValue({ content: 'GENERATED' })
    const { surface } = mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 's',
      initialDoc: DISK,
      initialBaseline: DISK
    })
    await userEvent.type(screen.getByLabelText('describe it'), 'a thing')
    await userEvent.type(surface, 'real body text')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(skillsWrite).toHaveBeenCalled())
    setDoc.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /draft/i }))
    // The proposal diff, not a direct write.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument())
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('offers another create-mode draft, and resumes it through editor.open carrying its name and draftId', async () => {
    const open = vi.fn()
    globalThis.window.argus.editor.open = open
    mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 'new-skill',
      initialDoc: 'seed',
      initialBaseline: 'seed',
      otherDrafts: [
        {
          kind: 'skill',
          name: 'half-written',
          mode: 'create',
          content: 'x',
          baseHash: null,
          updatedAt: '2026-07-31T10:00:00.000Z',
          draftId: 'other-draft-id'
        }
      ]
    })
    expect(screen.getByText(/1 unsaved new skill from earlier/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'half-written' }))
    expect(open).toHaveBeenCalledWith({
      kind: 'skill',
      name: 'half-written',
      mode: 'create',
      draftId: 'other-draft-id'
    })
  })

  it('resumes a legacy draft (no draftId) by name only, so the resumed tab can adopt it by name', async () => {
    const open = vi.fn()
    globalThis.window.argus.editor.open = open
    mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 'new-skill',
      initialDoc: 'seed',
      initialBaseline: 'seed',
      otherDrafts: [
        {
          kind: 'skill',
          name: 'half-written',
          mode: 'create',
          content: 'x',
          baseHash: null,
          updatedAt: '2026-07-31T10:00:00.000Z'
          // no draftId — a legacy record
        }
      ]
    })
    await userEvent.click(screen.getByRole('button', { name: 'half-written' }))
    expect(open).toHaveBeenCalledWith({ kind: 'skill', name: 'half-written', mode: 'create' })
    expect(open.mock.calls[0]?.[0]).not.toHaveProperty('draftId')
  })

  // The regression test for the reported defect: typing a name that matches an existing draft
  // used to synchronously replace that draft's pending copy with this tab's own content
  // (`DraftStore.writeKey` keyed by name, last-write-wins). With create mode keyed by `draftId`
  // instead, the two drafts occupy different storage keys from the start, so there is nothing for
  // the typed name to collide with — no banner, and no write anywhere near the other draft.
  it('shows no collision banner when the typed name matches another draft, and never touches it', async () => {
    mount({
      mode: 'create',
      draftId: 'draft-1',
      initialName: 'new-skill',
      initialDoc: 'seed',
      initialBaseline: 'seed',
      otherDrafts: [
        {
          kind: 'skill',
          name: 'new-skillX',
          mode: 'create',
          content: 'x',
          baseHash: null,
          updatedAt: '2026-07-31T10:00:00.000Z',
          draftId: 'other-draft-id'
        }
      ]
    })
    await userEvent.type(screen.getByLabelText('skill name'), 'X')
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'new-skillX', draftId: 'draft-1' })
      )
    )
    expect(discardDraft).not.toHaveBeenCalled()
  })

  // The `sync` derivation in AssetPane, not just the StatusBar it feeds — StatusBar.test.tsx only
  // proves the bar renders each state, not which state AssetPane picks.
  it('reads Saved for a file that was merely opened', async () => {
    mount()
    await waitFor(() => expect(screen.getByLabelText('skill · s')).toBeInTheDocument())
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('reads Draft the moment you type, before the debounced write lands', async () => {
    // The `|| dirty` clause. Between the keystroke and `onDraftSaved` the file genuinely is not
    // saved. Bare `Draft`, no timestamp — persist-before-adopt means only a confirmed write may
    // date it.
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument())
    expect(screen.queryByText(/^Draft ·/)).not.toBeInTheDocument()
  })

  it('dates the draft only once main confirms the write', async () => {
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument())
    // Fire the message main sends after the bytes are on disk.
    draftSavedListener!({ kind: 'skill', name: 's', updatedAt: '2026-07-31T15:42:00.000Z' })
    await waitFor(() => expect(screen.getByText(/^Draft ·/)).toBeInTheDocument())
  })

  it('reads Conflict while a conflict banner is up', async () => {
    // Explicit rather than relying on the previous tests' state: `vi.clearAllMocks()` in
    // `beforeEach` resets call history but not implementations, which is why `beforeEach` now
    // also `mockReset`s these two back to a freshly-opened asset.
    diskMovesDuringSave()
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Conflict')).toBeInTheDocument())
  })
})

describe('read-only panes', () => {
  it('disables Save', () => {
    mount({ readOnly: true })
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  // Both assist actions write into the buffer. On a buffer that cannot be saved they produce
  // text whose only possible destination is a draft that also must not exist (below).
  it('disables Improve', () => {
    mount({ readOnly: true })
    expect(screen.getByRole('button', { name: /improve/i })).toBeDisabled()
  })

  it('marks the surface read-only', () => {
    mount({ readOnly: true })
    expect(surfaceProps.readOnly).toBe(true)
  })

  it('leaves the surface writable for an editable asset', () => {
    mount({ readOnly: false })
    expect(surfaceProps.readOnly).toBe(false)
  })

  // A read-only buffer cannot be typed into, so any draft it filed could only ever equal disk —
  // and quick open (Increment 5) would surface it as an orphan for ever. Driven through the
  // surface's own onDocChange because there is no user-facing way to move the text at all.
  it('never files a draft', async () => {
    mount({ readOnly: true })
    act(() => surfaceProps.onDocChange('moved by something other than the user'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())
    expect(draftChanged).not.toHaveBeenCalled()
  })

  it('files a draft as usual when editable', async () => {
    mount({ readOnly: false })
    act(() => surfaceProps.onDocChange('typed'))
    await waitFor(() => expect(draftChanged).toHaveBeenCalled())
  })

  // Ctrl+S reaches onSave through the CodeMirror keymap and the window-level fallback, neither
  // of which consults the button's disabled attribute.
  it('ignores a save command while read-only', async () => {
    mount({ readOnly: true })
    act(() => surfaceProps.commands.save())
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())
    expect(skillsWrite).not.toHaveBeenCalled()
  })

  it('shows the tier in the status bar', () => {
    mount({ readOnly: true, tier: 'HiveMind' })
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('HiveMind')
  })
})

describe('background panes', () => {
  // Spec §4.4 rejected an fs watcher on cost. One readAsset per mounted tab per window focus
  // puts that cost straight back — and a banner on a tab you cannot see helps nobody.
  it('does not re-read disk on window focus while inactive', async () => {
    mount({ active: false })
    skillsRead.mockClear()
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => {})
    expect(skillsRead).not.toHaveBeenCalled()
  })

  it('re-reads disk on window focus while active', async () => {
    mount({ active: true })
    skillsRead.mockClear()
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(skillsRead).toHaveBeenCalled())
  })

  // Becoming active is the moment a stale banner starts mattering, and it is the only moment the
  // pane could have missed a focus event that fired while it was hidden.
  it('re-reads disk when it becomes active', async () => {
    const { rerender } = mount({ active: false })
    skillsRead.mockClear()
    rerender({ active: true })
    await waitFor(() => expect(skillsRead).toHaveBeenCalled())
  })

  it('re-measures the surface when it becomes active', async () => {
    const { rerender } = mount({ active: false })
    rerender({ active: true })
    await waitFor(() => expect(surfaceHandle.requestMeasure).toHaveBeenCalled())
  })

  // Restoring at mount would be wrong: a display-none view has no geometry, so the scroll and
  // the goToLine land nowhere. First activation is the first moment the geometry is real.
  it('applies a restored view state on first activation, not at mount', async () => {
    const { rerender } = mount({
      active: false,
      initialViewState: { line: 7, col: 2, scrollFraction: 0.25 }
    })
    expect(surfaceHandle.goToLine).not.toHaveBeenCalled()
    rerender({ active: true })
    // focus:false — a background tab being restored must not pull the caret out of the tab the
    // user is actually looking at.
    await waitFor(() =>
      expect(surfaceHandle.goToLine).toHaveBeenCalledWith(7, { col: 2, focus: false })
    )
  })

  // Imperative, not through the `scrollFraction` prop: driving it from React state would be a
  // synchronous setState in an effect body, which `react-hooks/set-state-in-effect` forbids.
  it('restores the scroll position imperatively', async () => {
    const { rerender } = mount({
      active: false,
      initialViewState: { line: 7, col: 2, scrollFraction: 0.25 }
    })
    rerender({ active: true })
    await waitFor(() => expect(surfaceHandle.scrollTo).toHaveBeenCalledWith(0.25))
  })

  it('does not re-apply the restored view state on a later activation', async () => {
    const { rerender } = mount({
      active: false,
      initialViewState: { line: 7, col: 2, scrollFraction: 0.25 }
    })
    rerender({ active: true })
    await waitFor(() => expect(surfaceHandle.goToLine).toHaveBeenCalledTimes(1))
    rerender({ active: false })
    rerender({ active: true })
    await waitFor(() => expect(surfaceHandle.requestMeasure).toHaveBeenCalledTimes(2))
    expect(surfaceHandle.goToLine).toHaveBeenCalledTimes(1)
  })

  // `initialViewState` is read once, into a ref, at mount — like every other `initial*` prop in
  // this component. The next task feeds this prop the *live* per-tab view state, which updates on
  // every cursor move; if it stayed in the reveal effect's dependency array, that effect (and its
  // `requestMeasure()` call) would re-run on every keystroke instead of only on activation.
  it('does not re-run the reveal effect when only initialViewState changes', async () => {
    const { rerender } = mount({
      active: true,
      initialViewState: { line: 7, col: 2, scrollFraction: 0.25 }
    })
    await waitFor(() => expect(surfaceHandle.requestMeasure).toHaveBeenCalledTimes(1))
    surfaceHandle.requestMeasure.mockClear()
    rerender({ initialViewState: { line: 99, col: 1, scrollFraction: 0.9 } })
    await act(async () => {})
    expect(surfaceHandle.requestMeasure).not.toHaveBeenCalled()
  })
})

// Task 10 deleted `AssetPane`'s window-level fallback keydown listener outright — the mechanism
// this block used to pin (every mounted pane racing its own `window` listener, first-opened
// winning) cannot happen any more, because there is now exactly one listener, held by `EditorApp`
// and reading the *active* tab through its command registry (lib/commands.ts). See
// `EditorApp.test.tsx`'s `EditorApp · commands` describe block for the replacement coverage,
// including the equivalent of what this block pinned (a shortcut reaching the pane that is
// actually on screen).

describe('name reporting', () => {
  // The strip shows the name, and in create mode the name field owns it. Without this the strip
  // would show the placeholder for the life of the tab.
  it('reports a create-mode rename upward', async () => {
    const { onNameChange } = mount({ mode: 'create', initialName: 'untitled' })
    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'renamed-skill')
    await waitFor(() => expect(onNameChange).toHaveBeenLastCalledWith('renamed-skill'))
  })

  it('reports the saved name after a save', async () => {
    const { onNameChange } = mount()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onNameChange).toHaveBeenLastCalledWith('s'))
  })
})

describe('view state reporting', () => {
  it('reports cursor moves for persistence', async () => {
    const { onViewStateChange } = mount()
    act(() => surfaceProps.onCursor({ line: 4, col: 9, selected: 0 }))
    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ line: 4, col: 9 })
      )
    )
  })

  it('reports scroll for persistence', async () => {
    const { onViewStateChange } = mount()
    act(() => surfaceProps.onScrollFraction!(0.6))
    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ scrollFraction: 0.6 })
      )
    )
  })

  // Each callback carries the OTHER value from its mirror ref. Without the mirrors, a scroll
  // would persist line 1 and a cursor move would persist fraction 0, so a restore would land
  // in the right line with the wrong scroll or vice versa.
  //
  // Both callbacks fire inside ONE `act()`, not two: CodeMirror's update listener and a scroll
  // event land in the same tick in the real surface, and two separate `act()` calls would let
  // React commit between them — which would make an effect-based mirror (instead of the
  // synchronous write beside each `setState`) look correct too, since it would be fresh again by
  // the time the second callback ran.
  it('keeps line and scroll together across both callbacks', async () => {
    const { onViewStateChange } = mount()
    act(() => {
      surfaceProps.onCursor({ line: 4, col: 9, selected: 0 })
      surfaceProps.onScrollFraction!(0.6)
    })
    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenLastCalledWith({ line: 4, col: 9, scrollFraction: 0.6 })
    )
  })
})

describe('AssetPane · command contract', () => {
  it('reports its state on mount', async () => {
    const onCommandState = vi.fn()
    renderPane({ active: true, onCommandState })
    await waitFor(() => expect(onCommandState).toHaveBeenCalled())
    expect(onCommandState.mock.lastCall![0]).toMatchObject({
      mode: 'edit',
      readOnly: false,
      busy: false,
      proposing: false,
      blocked: false,
      hasDraft: false
    })
  })

  it('reports again when the document stops validating', async () => {
    const onCommandState = vi.fn()
    renderPane({ active: true, onCommandState })
    await waitFor(() => expect(onCommandState).toHaveBeenCalled())
    // An empty document is a blocking validation error for both kinds.
    fireEvent.change(screen.getByRole('textbox', { name: /skill · /i }), { target: { value: '' } })
    await waitFor(() => expect(onCommandState.mock.lastCall![0].blocked).toBe(true))
  })

  it('reports canImprove off for an empty document', async () => {
    const onCommandState = vi.fn()
    renderPane({ active: true, initialDoc: '', initialBaseline: '', onCommandState })
    await waitFor(() => expect(onCommandState.mock.lastCall![0].canImprove).toBe(false))
  })

  it('does not report from an INACTIVE pane', async () => {
    const onCommandState = vi.fn()
    renderPane({ active: false, onCommandState })
    // Give any effect a chance to run before asserting the negative.
    await waitFor(() => expect(screen.getByRole('textbox', { name: /skill · /i })).toBeTruthy())
    expect(onCommandState).not.toHaveBeenCalled()
  })

  it('exposes a handle whose save writes the asset', async () => {
    const paneRef = createRef<AssetPaneHandle>()
    renderPane({ active: true, paneRef })
    await waitFor(() => expect(paneRef.current).not.toBeNull())
    paneRef.current!.save()
    await waitFor(() => expect(window.argus.skills.write).toHaveBeenCalled())
  })

  it('exposes a handle whose save is refused on a read-only pane', async () => {
    const paneRef = createRef<AssetPaneHandle>()
    renderPane({ active: true, readOnly: true, paneRef })
    await waitFor(() => expect(paneRef.current).not.toBeNull())
    paneRef.current!.save()
    await new Promise((r) => setTimeout(r, 0))
    expect(window.argus.skills.write).not.toHaveBeenCalled()
  })

  it('exposes a handle whose cycleViewMode moves the view mode it then reports', async () => {
    const paneRef = createRef<AssetPaneHandle>()
    const onCommandState = vi.fn()
    renderPane({ active: true, paneRef, onCommandState })
    await waitFor(() => expect(paneRef.current).not.toBeNull())
    expect(onCommandState.mock.lastCall![0].viewMode).toBe('editor')
    act(() => paneRef.current!.cycleViewMode())
    await waitFor(() => expect(onCommandState.mock.lastCall![0].viewMode).toBe('split'))
  })

  // Pins the `commandState` memo's stability directly. `useAssistProvider` (mocked above) returns
  // a brand-new object literal on every call, exactly like the real hook — so a re-render that
  // changes nothing the memo reads must not re-fire the report effect. Before the fix, the memo's
  // dependency array carried the whole `provider` object, which fails `Object.is` every render and
  // defeats the memo unconditionally; the first assertion below fails against that code (verified:
  // it reported a second time after a no-op re-render). The final assertion guards against the
  // opposite mistake — a callback so dead the test would pass by never firing at all.
  it('does not re-report on a no-op re-render, but does when a reported field actually changes', async () => {
    const onCommandState = vi.fn()
    const { rerender, surface } = mount({ active: true, onCommandState })
    await waitFor(() => expect(onCommandState).toHaveBeenCalled())
    // Let any pending async effects from mount (e.g. the active-pane disk freshness check) settle
    // before taking the baseline count, so they can't be mistaken for the re-render under test.
    await act(async () => {})
    const callsAfterMount = onCommandState.mock.calls.length

    // `tier` is display-only (passed straight to `StatusBar`) and appears nowhere in the
    // `commandState` memo or its dependency list — a clean lever for "re-render, nothing
    // reportable moved".
    rerender({ tier: 'HiveMind' })
    await act(async () => {})
    expect(onCommandState.mock.calls.length).toBe(callsAfterMount)

    // Now change something that genuinely belongs in `commandState`: an empty document is a
    // blocking validation error, which flips `blocked`.
    fireEvent.change(surface, { target: { value: '' } })
    await waitFor(() => expect(onCommandState.mock.lastCall![0].blocked).toBe(true))
    expect(onCommandState.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })
})

describe('AssetPane · toolbar from descriptors', () => {
  const cmd = (id: string, over: Partial<Command> = {}): Command => ({
    id,
    title: id,
    section: 'File',
    enabled: true,
    run: vi.fn(),
    ...over
  })

  it('disables Save when the descriptor says so, whatever the pane thinks', async () => {
    renderPane({ active: true, commands: [cmd('save', { enabled: false })] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  it('runs the descriptor, not a local handler', async () => {
    const save = cmd('save')
    renderPane({ active: true, commands: [save] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save.run).toHaveBeenCalledOnce()
    expect(window.argus.skills.write).not.toHaveBeenCalled()
  })

  it('hides Improve when no descriptor for it is supplied', async () => {
    renderPane({ active: true, commands: [cmd('save')] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /improve/i })).toBeNull()
  })

  it('still works standalone, with no descriptors at all', async () => {
    renderPane({ active: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(window.argus.skills.write).toHaveBeenCalled())
  })
})

// Finding 2: the local fallback `enabled` expressions (used only when no `commands` host is
// supplied — this component's own tests, exercised throughout this file) had each dropped one
// term `buildCommands` (lib/commands.ts) includes for the same id, so a button behaved
// differently under test than it would in the real window. One test per button that is
// independently observable through the rendered DOM; `draft`'s missing term (`proposed === null`)
// is NOT included here — it is masked by this component's own JSX render gate, which already
// hides the Draft button whenever a proposal is pending, so there is no rendered state that could
// tell the fixed expression apart from the old one. See the comments beside each fallback in
// AssetPane.tsx for the full `buildCommands` correspondence.
describe('AssetPane · toolbar fallback matches buildCommands', () => {
  it('disables Save via the fallback when validation is blocked', () => {
    // buildCommands: `writable && !p.blocked` — the fallback used to omit `!blocked` entirely, so
    // a build with unresolved validation errors offered a Save button the real window would have
    // refused.
    mount({ initialDoc: 'no frontmatter', initialBaseline: 'no frontmatter' })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('disables the view-mode toggle via the fallback while an assist run is busy', async () => {
    // buildCommands: `idle` = `!busy && proposed === null` — the fallback used to check only
    // `proposed === null`, so the toolbar's view-mode button (labelled by the *next* mode; the
    // default 'editor' mode shows 'Split') stayed enabled for the whole span of a running assist.
    globalThis.window.argus.authoring.improve = vi.fn(
      () => new Promise<{ content: string }>(() => {})
    )
    mount()
    await userEvent.click(screen.getByRole('button', { name: /improve/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled())
  })

  it('disables Improve via the fallback while a proposal is pending', async () => {
    // buildCommands: `writable && p.canImprove`, where `writable` already folds in
    // `proposed === null` — the fallback used to omit that term, so Improve stayed clickable while
    // its own previous proposal was still on screen awaiting Accept/Discard.
    //
    // Queried with `hidden: true`: once a proposal lands, this component's own overlay wrapper
    // marks the whole footer (Improve included) `aria-hidden` — correct per its own comment, since
    // Tailwind's `hidden` utility has no effect under jsdom's CSS-less DOM — so the default
    // accessible-name query would otherwise report the button as gone rather than disabled.
    globalThis.window.argus.authoring.improve = vi.fn().mockResolvedValue({ content: 'PROPOSED' })
    mount()
    await userEvent.click(screen.getByRole('button', { name: /improve/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Accept', hidden: true })).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /improve/i, hidden: true })).toBeDisabled()
  })
})
