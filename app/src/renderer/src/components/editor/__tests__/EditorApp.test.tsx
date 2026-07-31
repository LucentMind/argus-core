// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorApp } from '../EditorApp'
import type { SurfaceHandle } from '../surface'
import type { EditorOpenRequest } from '../../../../../shared/editorIpc'

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
        focus: vi.fn()
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
const setDirty = vi.fn()
const respondClose = vi.fn()

beforeEach(() => {
  openTab = null
  closeRequested = null
  setDirty.mockClear()
  respondClose.mockClear()
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
      listDrafts: vi.fn().mockResolvedValue([]),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      onDraftSaved: () => () => {}
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
      write: vi.fn().mockResolvedValue({ skills: [], hash: 'h1-new' })
    },
    refsync: {
      readRef: vi.fn().mockResolvedValue({ content: '# ref\n', hash: 'h2' }),
      // refsync:write's real result is a bare hash string, unlike skills:write's object.
      writeRef: vi.fn().mockResolvedValue('h2-new')
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
    // ...and its content must actually reach the textarea, proving AssetTab really remounted
    // against the new id rather than the click silently doing nothing.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('skill · my-skill').value).toBe(
        '# resumed draft content\n'
      )
    )
  })
})
