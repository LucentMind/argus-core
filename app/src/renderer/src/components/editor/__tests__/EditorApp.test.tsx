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
    skills: { read: vi.fn().mockResolvedValue({ content: '# hi\n', hash: 'h1' }) },
    refsync: { readRef: vi.fn().mockResolvedValue({ content: '# ref\n', hash: 'h2' }) }
  } as never
})

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }

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
