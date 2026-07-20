// @vitest-environment jsdom
import { StrictMode } from 'react'
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
    const urls = new Map<Blob, string>()
    let n = 0
    URL.createObjectURL = vi.fn((b: Blob) => {
      const url = `blob:${++n}`
      urls.set(b, url)
      return url
    })
    const revoke = vi.fn()
    URL.revokeObjectURL = revoke
    const blobOne = new Blob(['one'])
    const blobTwo = new Blob(['two'])
    const first: Attachment = { ...ready('a', 'evidence/one.png'), previewBlob: blobOne }
    const second: Attachment = { ...ready('b', 'evidence/two.png'), previewBlob: blobTwo }
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
    const urlOne = urls.get(blobOne)
    const urlTwo = urls.get(blobTwo)
    expect(revoke).toHaveBeenCalledWith(urlTwo)
    expect(revoke).not.toHaveBeenCalledWith(urlOne)
  })

  it('remounting a chip after unmount (session-switch scenario) mints a fresh, working URL', () => {
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:${++n}`)
    const revoked: string[] = []
    URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url))
    const blob = new Blob(['shot'])
    const attachment: Attachment = { ...ready('a', 'evidence/shot.png'), previewBlob: blob }
    const props = {
      disabled: false,
      onSend: vi.fn(),
      onRemoveAttachment: () => {},
      onAttachFiles: () => {}
    }
    // mount 1: e.g. Composer mounted for session A
    // alt="" gives the thumbnail a presentation role, so query by tag
    const { unmount, container } = render(<Composer {...props} attachments={[attachment]} />)
    const firstImg = container.querySelector('img') as HTMLImageElement
    const firstUrl = firstImg.getAttribute('src')
    expect(revoked).not.toContain(firstUrl)

    // simulate the ChatPane session-switch remount: Composer is keyed per
    // session, so switching away and back unmounts and remounts it while
    // composerAttachments (and this same `attachment` object) is retained
    unmount()
    expect(revoked).toContain(firstUrl)

    // mount 2: switching back to session A — same attachment, new chip instance
    const { container: container2 } = render(<Composer {...props} attachments={[attachment]} />)
    const secondImg = container2.querySelector('img') as HTMLImageElement
    const secondUrl = secondImg.getAttribute('src')

    // this is the crux of the fix: the URL rendered after remount must be a
    // fresh one, not the already-revoked URL from the first mount
    expect(secondUrl).not.toBe(firstUrl)
    expect(revoked).not.toContain(secondUrl)
  })

  it('renders a live (non-revoked) preview url under StrictMode', () => {
    // the app mounts under StrictMode (main.tsx); dev double-invokes effect
    // setup/cleanup on mount. A chip that mints its object URL during render
    // (lazy useState initializer) and only revokes in effect cleanup ends up
    // rendering the ALREADY-REVOKED url after the simulated remount, because
    // useState preserves state across it while the cleanup still fires.
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:${++n}`)
    const revoked: string[] = []
    URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url))
    const blob = new Blob(['shot'])
    const attachment: Attachment = { ...ready('a', 'evidence/shot.png'), previewBlob: blob }
    const { container } = render(
      <StrictMode>
        <Composer
          disabled={false}
          onSend={vi.fn()}
          attachments={[attachment]}
          onRemoveAttachment={() => {}}
          onAttachFiles={() => {}}
        />
      </StrictMode>
    )
    const img = container.querySelector('img') as HTMLImageElement
    const renderedUrl = img.getAttribute('src')
    expect(revoked).not.toContain(renderedUrl)
  })

  it('forwards pasted files to onAttachFiles marked as clipboard-sourced', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    // Chromium supplies a synthetic name like this for a pasted screenshot — the
    // `fromClipboard` flag, not the filename, is what tells the owner it's clipboard data.
    const file = new File([new Uint8Array(4)], 'image.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), pasteEvent([file]))
    expect(onAttach).toHaveBeenCalledWith([file], { fromClipboard: true })
  })

  it('leaves a text-only paste to the browser', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), pasteEvent([]))
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('forwards dropped files to onAttachFiles without the clipboard flag', () => {
    const onAttach = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onAttachFiles={onAttach} />)
    const file = new File([new Uint8Array(4)], 'log.txt', { type: 'text/plain' })
    fireEvent.drop(screen.getByPlaceholderText(/Message the analyst/i), {
      dataTransfer: { files: [file], types: ['Files'] } as never
    })
    // exactly one argument — no second (opts) arg is passed for a drop
    expect(onAttach).toHaveBeenCalledWith([file])
    expect(onAttach.mock.calls[0]).toHaveLength(1)
  })
})
