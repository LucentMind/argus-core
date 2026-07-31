// @vitest-environment jsdom
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { AssetPane } from '../AssetPane'
import type { SurfaceHandle } from '../surface'
import type { DraftSaved } from '../../../../../shared/editorIpc'

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
        getDoc: () => globalThis.__doc ?? initialDoc,
        setDoc: (text: string) => {
          setDoc(text)
          globalThis.__doc = text
          onDocChange(text)
        },
        goToLine: vi.fn(),
        focus: vi.fn()
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

beforeEach(() => {
  vi.clearAllMocks()
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

const DISK = '---\nname: s\ndescription: d\n---\n\nbody\n'

function mount(
  overrides: Partial<React.ComponentProps<typeof AssetPane>> = {},
  /** `strict` wraps the tree in `<StrictMode>`, which double-invokes mount effects — the only
   *  way a test can see a mount-effect ref that is never re-armed. */
  opts: { strict?: boolean } = {}
): {
  onDirtyChange: ReturnType<typeof vi.fn>
  surface: HTMLElement
} {
  const onDirtyChange = vi.fn()
  const props: React.ComponentProps<typeof AssetPane> = {
    kind: 'skill',
    initialName: 's',
    mode: 'edit',
    initialDoc: DISK,
    initialBaseline: DISK,
    initialHash: 'h1',
    initialBanner: { kind: 'none' },
    initialDraftAt: null,
    otherDrafts: [],
    onDirtyChange,
    ...overrides
  }
  const tree = <AssetPane {...props} />
  render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree)
  // Derived, not the literal 'skill · s': the create-mode cases below mount under a different
  // name and the surface's aria-label follows it.
  return {
    onDirtyChange,
    surface: screen.getByLabelText(`${props.kind} · ${props.initialName}`)
  }
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

  it('cycles the view mode from a window-level key, not only from the focused editor', async () => {
    // Preview mode makes the surface `inert`, so CodeMirror's keymap never sees the key. jsdom
    // does not honour `inert`, so this test cannot reproduce that state — what it pins is that
    // the fallback listener exists and is wired to the command at all, which is the part that
    // regressed to nothing.
    mount()
    await waitFor(() => expect(screen.getByLabelText('skill · s')).toBeInTheDocument())
    const before = screen.getByRole('button', { name: /^View mode:/ }).getAttribute('aria-label')
    fireEvent.keyDown(window, { key: 'V', ctrlKey: true, shiftKey: true })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^View mode:/ }).getAttribute('aria-label')
      ).not.toBe(before)
    )
  })

  it('raises the conflict banner when a save is rejected because disk moved', async () => {
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
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
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
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
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
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
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
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
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
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
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(skillsWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/frontmatter/i)
  })

  it('re-keys the draft when a create-mode name is edited', async () => {
    mount({ mode: 'create', initialName: 'new-skill', initialDoc: 'seed', initialBaseline: 'seed' })
    await userEvent.type(screen.getByLabelText('skill name'), 'X')
    await waitFor(() => expect(draftChanged).toHaveBeenCalled())
    expect(draftChanged.mock.calls.at(-1)![0]).toMatchObject({
      name: 'new-skillX',
      replaces: { kind: 'skill', name: 'new-skill' }
    })
  })

  it('reseeds the template when a create-mode draft is discarded', async () => {
    // Explicit, because `vi.clearAllMocks()` clears calls but not implementations — without this
    // the conflict cases above leave `skillsRead` resolving to a file, and a create-mode asset by
    // definition has none.
    skillsRead.mockRejectedValue(new Error('ENOENT'))
    mount({
      mode: 'create',
      initialName: 'new-skill',
      initialDoc: 'typed body',
      initialBaseline: 'seed',
      initialDraftAt: '2026-07-31T15:42:00.000Z',
      initialBanner: { kind: 'restored', updatedAt: '2026-07-31T15:42:00.000Z' }
    })
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    expect(setDoc.mock.calls.at(-1)![0]).toContain('name: new-skill')
  })

  it('stops reporting dirty after a create-mode save, even with a Describe prompt typed', async () => {
    skillsWrite.mockResolvedValue({ hash: 'h2' })
    const { onDirtyChange } = mount({
      mode: 'create',
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

  it('offers other create-mode drafts to resume', async () => {
    const open = vi.fn()
    globalThis.window.argus.editor.open = open
    mount({
      mode: 'create',
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
        }
      ]
    })
    expect(screen.getByText(/1 unsaved new skill from earlier/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'half-written' }))
    expect(open).toHaveBeenCalledWith({ kind: 'skill', name: 'half-written', mode: 'create' })
  })

  it('warns before a typed name silently overwrites an existing draft', async () => {
    mount({
      mode: 'create',
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
          updatedAt: '2026-07-31T10:00:00.000Z'
        }
      ]
    })
    // `DraftStore.writeKey` is still last-write-wins; the fix is that the overwrite becomes
    // visible to the person typing rather than happening without a word.
    await userEvent.type(screen.getByLabelText('skill name'), 'X')
    expect(
      screen.getByText(/already exists — what you type here will replace it/i)
    ).toBeInTheDocument()
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
    // `beforeEach` resets call history but not implementations, so an earlier conflict test's
    // `mockRejectedValue`/`mockResolvedValue` would otherwise leak forward.
    skillsWrite.mockRejectedValue(new Error('changed on disk'))
    skillsRead.mockResolvedValue({ content: 'OTHER', hash: 'h2' })
    const { surface } = mount()
    await userEvent.type(surface, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Conflict')).toBeInTheDocument())
  })
})
