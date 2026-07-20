// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Composer } from '../Composer'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { Attachment } from '../../lib/composerAttachments'

beforeEach(() => {
  localStorage.clear()
  uiStore.setShowToolCalls(true)
  settingsStore.reset()
  window.argus = {
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

const ready = (id: string, relPath: string): Attachment => ({
  id,
  name: relPath.replace('evidence/', ''),
  status: 'ready',
  relPath
})

function pasteEvent(files: File[]): { clipboardData: DataTransfer } {
  return {
    clipboardData: { files, items: [], types: files.length ? ['Files'] : ['text/plain'] } as never
  }
}

describe('Composer attachments', () => {
  it('appends attachment references after citations on send', () => {
    const onSend = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        citations={[{ relPath: 'evidence/log.txt', line: 12 }]}
        onRemoveCitation={() => {}}
        onCitationsConsumed={() => {}}
        attachments={[ready('a', 'evidence/shot.png')]}
        onRemoveAttachment={() => {}}
        onAttachFiles={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText(/Message the analyst/i), {
      target: { value: 'see this' }
    })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).toHaveBeenCalledWith('see this\n\n[evidence/log.txt:12]\n\n[evidence/shot.png]')
  })

  it('sends one reference per line for multiple attachments', () => {
    const onSend = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        attachments={[ready('a', 'evidence/one.png'), ready('b', 'evidence/two.png')]}
        onRemoveAttachment={() => {}}
        onAttachFiles={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).toHaveBeenCalledWith('[evidence/one.png]\n[evidence/two.png]')
  })

  it('omits pending and errored attachments from the sent body', () => {
    const onSend = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        attachments={[
          { id: 'p', name: 'p.png', status: 'pending' },
          { id: 'e', name: 'e.png', status: 'error', error: 'disk full' },
          ready('r', 'evidence/ok.png')
        ]}
        onRemoveAttachment={() => {}}
        onAttachFiles={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText(/Message the analyst/i), {
      target: { value: 'hi' }
    })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).toHaveBeenCalledWith('hi\n\n[evidence/ok.png]')
  })

  it('does not send when the text is empty and every attachment is still pending', () => {
    const onSend = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        attachments={[{ id: 'p', name: 'p.png', status: 'pending' }]}
        onRemoveAttachment={() => {}}
        onAttachFiles={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('renders a chip per attachment and removes by id', () => {
    const onRemove = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        attachments={[ready('a', 'evidence/one.png'), ready('b', 'evidence/two.png')]}
        onRemoveAttachment={onRemove}
        onAttachFiles={() => {}}
      />
    )
    expect(screen.getByText('one.png')).toBeTruthy()
    expect(screen.getByText('two.png')).toBeTruthy()
    fireEvent.click(screen.getAllByTitle('Remove attachment')[1])
    expect(onRemove).toHaveBeenCalledWith('b')
  })

  it('shows the failure message on an errored chip', () => {
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        attachments={[{ id: 'e', name: 'bad.png', status: 'error', error: 'disk full' }]}
        onRemoveAttachment={() => {}}
        onAttachFiles={() => {}}
      />
    )
    expect(screen.getByTitle('disk full')).toBeTruthy()
  })

  it('revokes a preview url when its chip goes away, including one added later', () => {
    const revoke = vi.fn()
    URL.revokeObjectURL = revoke
    const first: Attachment = { ...ready('a', 'evidence/one.png'), previewUrl: 'blob:one' }
    const second: Attachment = { ...ready('b', 'evidence/two.png'), previewUrl: 'blob:two' }
    const props = {
      disabled: false,
      onSend: vi.fn(),
      onRemoveAttachment: () => {},
      onAttachFiles: () => {}
    }
    const { rerender } = render(<Composer {...props} attachments={[first]} />)
    // `second` is added AFTER mount — a tray-level cleanup would never revoke it
    rerender(<Composer {...props} attachments={[first, second]} />)
    rerender(<Composer {...props} attachments={[first]} />)
    expect(revoke).toHaveBeenCalledWith('blob:two')
    expect(revoke).not.toHaveBeenCalledWith('blob:one')
  })

  it('forwards pasted files to onAttachFiles', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    const file = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), pasteEvent([file]))
    expect(onAttach).toHaveBeenCalledWith([file])
  })

  it('leaves a text-only paste to the browser', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), pasteEvent([]))
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('forwards dropped files to onAttachFiles', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    const file = new File([new Uint8Array(4)], 'log.txt', { type: 'text/plain' })
    fireEvent.drop(screen.getByPlaceholderText(/Message the analyst/i), {
      dataTransfer: { files: [file], types: ['Files'] } as never
    })
    expect(onAttach).toHaveBeenCalledWith([file])
  })
})
