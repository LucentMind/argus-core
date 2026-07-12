// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Composer } from '../Composer'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'

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

describe('Composer citations', () => {
  it('appends citation markdown to the sent message and clears the tray', () => {
    const onSend = vi.fn()
    const onConsumed = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        citations={[{ relPath: 'evidence/log.txt', line: 12 }]}
        onRemoveCitation={() => {}}
        onCitationsConsumed={onConsumed}
      />
    )
    fireEvent.change(screen.getByPlaceholderText(/Message the analyst/i), {
      target: { value: 'look at this' }
    })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).toHaveBeenCalledWith('look at this\n\n[evidence/log.txt:12]')
    expect(onConsumed).toHaveBeenCalled()
  })

  it('sends just the citation markdown when the text box is empty', () => {
    const onSend = vi.fn()
    const onConsumed = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        citations={[{ relPath: 'evidence/log.txt', line: 12 }]}
        onRemoveCitation={() => {}}
        onCitationsConsumed={onConsumed}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(onSend).toHaveBeenCalledWith('[evidence/log.txt:12]')
    expect(onConsumed).toHaveBeenCalled()
  })

  it('renders removable chips for each pending citation', () => {
    const onRemove = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        citations={[
          { relPath: 'evidence/log.txt', line: 12 },
          { relPath: 'evidence/other.txt', line: 3 }
        ]}
        onRemoveCitation={onRemove}
        onCitationsConsumed={vi.fn()}
      />
    )
    expect(screen.getByText('evidence/log.txt:12')).toBeTruthy()
    expect(screen.getByText('evidence/other.txt:3')).toBeTruthy()
    fireEvent.click(screen.getAllByTitle('Remove citation')[0])
    expect(onRemove).toHaveBeenCalledWith(0)
  })
})
