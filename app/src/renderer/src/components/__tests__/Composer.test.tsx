// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react'
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
        resolvedTools: {
          traceDir: { value: null, source: 'default' },
          parseBin: { value: null, source: 'default' }
        },
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('Composer', () => {
  it('renders session-option placeholders and lets a value be picked (local only)', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    expect(screen.getByText('Claude Fable 5')).toBeTruthy()
    expect(screen.getByText('High · 200k')).toBeTruthy()
    expect(screen.getByText('Ask approvals')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Fable 5'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Sonnet 5' }))
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('tool-results toggle flips uiStore.showToolCalls', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide tool results' }))
    expect(uiStore.get().showToolCalls).toBe(false)
    expect(screen.getByRole('button', { name: 'Show tool results' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show tool results' }))
    expect(uiStore.get().showToolCalls).toBe(true)
  })

  it('circular send button sends trimmed text and disables when empty', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} />)
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/message the analyst/i), {
      target: { value: '  hello  ' }
    })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('seeds model and permission pickers from settings once loaded', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: (() => {
        const s = defaultSettings()
        s.agent.defaultPermissionMode = 'plan'
        s.agent.providerInstances['claude-default'].config = { model: 'claude-opus-4-8' }
        return s
      })(),
      resolvedTools: {
        traceDir: { value: null, source: 'default' },
        parseBin: { value: null, source: 'default' }
      },
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    render(<Composer disabled={false} onSend={vi.fn()} />)
    expect(await screen.findByText('claude-opus-4-8')).toBeTruthy()
    expect(screen.getByText('Plan mode')).toBeTruthy()
  })

  it('model picker follows ordering + visibility: favorites/order first, hidden excluded, seed = top model', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: (() => {
        const s = defaultSettings()
        s.agent.modelPreferences['claude-default'] = {
          hiddenModels: ['claude-haiku-4-5'],
          favoriteModels: ['claude-sonnet-5'],
          modelOrder: []
        }
        return s
      })(),
      resolvedTools: {
        traceDir: { value: null, source: 'default' },
        parseBin: { value: null, source: 'default' }
      },
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    render(<Composer disabled={false} onSend={vi.fn()} />)
    // seeded chip shows the top ordered visible model (favorite pinned first)
    expect(await screen.findByText('claude-sonnet-5')).toBeTruthy()
    fireEvent.click(screen.getByText('claude-sonnet-5'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(items).toEqual([
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6'
    ])
    expect(items).not.toContain('claude-haiku-4-5')
  })

  it('skill picker offers only enabled skills when typing /', async () => {
    window.argus.skills.list = vi.fn(async () => ({
      skills: [
        {
          name: 'rca',
          tier: 'bundled' as const,
          description: 'Root cause analysis',
          enabled: true,
          shadows: []
        },
        {
          name: 'analyze-applog',
          tier: 'bundled' as const,
          description: 'Analyze Android logs',
          enabled: false,
          shadows: []
        }
      ]
    }))
    render(<Composer disabled={false} onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText(/message the analyst/i)
    fireEvent.change(textarea, { target: { value: '/' } })
    // rca should be offered (enabled: true)
    expect(await screen.findByText('/rca')).toBeTruthy()
    // analyze-applog should NOT be offered (enabled: false)
    expect(screen.queryByText('/analyze-applog')).toBeNull()
  })
})
