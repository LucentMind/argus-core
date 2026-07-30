// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorApp } from '../EditorApp'
import type { EditorOpenRequest } from '../../../../../shared/editorIpc'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: vi.fn(() => ({ ok: true, text: 'via claude' }))
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
      respondClose
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
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    closeRequested!({ dirtyCount: 1 })

    // Not /close/i: ModalShell's own dismiss icon is also named "Close", so the confirm
    // button carries a distinct label rather than a second identically-named button.
    const confirmBtn = await screen.findByRole('button', { name: 'Close editor' })
    await userEvent.click(confirmBtn)
    await waitFor(() => expect(respondClose).toHaveBeenCalledWith(true))
  })

  it('reports clean once a saved editor closes, so main does not keep warning about it', async () => {
    render(<EditorApp />)
    openTab!(SKILL)
    const area = await screen.findByLabelText('skill · my-skill')
    await userEvent.type(area, 'x')
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(1))

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(screen.getByText(/nothing open/i)).toBeInTheDocument())
    expect(setDirty).toHaveBeenLastCalledWith(0)
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

    // Hold the first write pending so we can move the buffer while it's in flight — that's
    // what makes AssetEditor keep the editor open after this save resolves (it only closes
    // when the buffer at resolution time still matches what was sent), so a second, real save
    // happens in the same session and we can inspect what baseHash it used.
    let resolveWrite: (v: { skills: never[]; hash: string }) => void = () => {}
    vi.mocked(window.argus.skills.write).mockImplementationOnce(
      () => new Promise((resolve) => (resolveWrite = resolve))
    )

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await userEvent.type(area, 'y')
    resolveWrite({ skills: [], hash: 'h1-second' })

    // Confirms the editor stayed open (didn't adopt undefined and silently misbehave) and that
    // AssetEditor did adopt the returned hash into baseHash, per the comment on its save prop.
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
