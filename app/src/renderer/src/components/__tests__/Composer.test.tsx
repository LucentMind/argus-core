// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Composer } from '../Composer'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, settingsSchema } from '../../../../shared/settings'
import { DRIVERS } from '../../../../shared/drivers'
import { clearCatalogStore } from '../../lib/catalogStore'
import type { ModelOptionInfo } from '../../../../shared/runOptions'

beforeEach(() => {
  localStorage.clear()
  uiStore.setShowToolCalls(true)
  settingsStore.reset()
  clearCatalogStore()
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
    },
    // Empty by default: the picker falls back to the static list, which is what
    // every existing test here asserts against. Tests exercising the runtime
    // catalog itself override this per-case.
    models: { catalog: vi.fn(async () => []) }
  } as never
})

describe('Composer', () => {
  it('exposes the onboarding anchor on its root element', () => {
    const { container } = render(<Composer disabled={false} onSend={vi.fn()} />)
    expect(container.querySelector('[data-onboarding-anchor="composer"]')).toBeTruthy()
  })

  it('renders the option chips, falling back to static labels before settings load', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    expect(screen.getByText('Claude Fable 5')).toBeTruthy()
    expect(screen.getByText('High · 200k')).toBeTruthy()
    expect(screen.getByText('Ask approvals')).toBeTruthy()
  })

  it('reasoning stays a local, still-unwired picker', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    fireEvent.click(screen.getByText('High · 200k'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Low · 16k' }))
    expect(screen.getByText('Low · 16k')).toBeTruthy()
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

  it('seeds the permission picker from settings, and the model chip from the settings default', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: (() => {
        const s = defaultSettings()
        s.agent.defaultPermissionMode = 'plan'
        s.agent.providerInstances['claude-default'].config = { model: 'claude-opus-4-8' }
        return s
      })(),
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    render(<Composer disabled={false} onSend={vi.fn()} />)
    // hand-set config.model still wins for an unpinned chat (back-compat)
    expect(await screen.findByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('Plan mode')).toBeTruthy()
  })

  it('shows the model the SESSION is pinned to, over the settings default', async () => {
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        session={{
          id: 1,
          title: '',
          turnCount: 0,
          updatedAt: '',
          driverKind: 'claude-agent-sdk',
          instanceId: 'claude-default',
          model: 'claude-haiku-4-5',
          mode: 'investigation',
          runOptions: [],
          permissionMode: null
        }}
      />
    )
    expect(await screen.findByText('Claude Haiku 4.5')).toBeTruthy()
  })

  it('while the catalog is still loading, the picker shows the static list unchanged — the chip is never blank', async () => {
    // A promise that never resolves during this test: the catalog store's cache stays
    // empty, so this pins the "still loading" state rather than the "resolved empty" one.
    window.argus.models.catalog = vi.fn(() => new Promise<ModelOptionInfo[]>(() => {}))
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        session={{
          id: 1,
          title: '',
          turnCount: 0,
          updatedAt: '',
          driverKind: 'claude-agent-sdk',
          instanceId: 'claude-default',
          model: 'claude-sonnet-5',
          mode: 'investigation',
          runOptions: [],
          permissionMode: null
        }}
      />
    )
    // settings resolve (async), the catalog fetch never does — the chip must still show
    // the session's statically-known pinned model, not go blank waiting on the catalog.
    expect(await screen.findByText('Claude Sonnet 5')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Sonnet 5'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // the full static catalog is offered, unchanged — no catalog-only row leaked in
    expect(items).toEqual([
      'Claude Fable 5',
      'Claude Opus 4.8',
      'Claude Opus 4.7',
      'Claude Sonnet 5',
      'Claude Sonnet 4.6',
      'Claude Haiku 4.5'
    ])
  })

  it("the runtime catalog supersedes the static list for the session's instance, surfacing a model the static list lacks", async () => {
    window.argus.models.catalog = vi.fn(async (instanceId: string) => {
      expect(instanceId).toBe('claude-default')
      return [{ value: 'opus[1m]', displayName: 'Opus (1M context)' }]
    })
    const onModelChange = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        onModelChange={onModelChange}
        session={{
          id: 1,
          title: '',
          turnCount: 0,
          updatedAt: '',
          driverKind: 'claude-agent-sdk',
          instanceId: 'claude-default',
          model: 'opus[1m]',
          mode: 'investigation',
          runOptions: [],
          permissionMode: null
        }}
      />
    )
    // catalog-only row, not present in the static CLAUDE_MODELS list at all
    expect(await screen.findByText('Opus (1M context)')).toBeTruthy()
    fireEvent.click(screen.getByText('Opus (1M context)'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // for this single enabled instance, the runtime catalog rows replace the static list
    expect(items).toEqual(['Opus (1M context)'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus (1M context)' }))
    // and the catalog-only row still carries the SESSION's own instance identity
    expect(onModelChange).toHaveBeenCalledWith('claude-default', 'opus[1m]')
  })

  it('a loaded catalog for the session instance does not hide OTHER enabled providers (regression: catalog used to replace the whole picker)', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: settingsSchema.parse({
        agent: {
          activeInstanceId: 'claude-default',
          providerInstances: {
            'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
            'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
        }
      }),
      resolvedTools: [],
      dataRoot: { path: 'C:/x', fromEnv: false },
      loadError: null
    }))
    window.argus.models.catalog = vi.fn(async (instanceId: string) => {
      expect(instanceId).toBe('claude-default')
      return [{ value: 'opus[1m]', displayName: 'Opus (1M context)' }]
    })
    render(
      <Composer
        disabled={false}
        onSend={vi.fn()}
        session={{
          id: 1,
          title: '',
          turnCount: 0,
          updatedAt: '',
          driverKind: 'claude-agent-sdk',
          instanceId: 'claude-default',
          model: 'opus[1m]',
          mode: 'investigation',
          runOptions: [],
          permissionMode: null
        }}
      />
    )
    fireEvent.click(await screen.findByText('Opus (1M context) · Claude'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // Claude's catalog substitutes its own rows...
    expect(items).toContain('Opus (1M context) · Claude')
    // ...but Copilot, a completely different enabled instance, must still be offered —
    // the model picker is how the user switches provider.
    expect(items).toContain('Auto · Copilot')
  })

  it('picking a model re-pins the session rather than only changing local state', async () => {
    const onModelChange = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onModelChange={onModelChange} />)
    fireEvent.click(await screen.findByText('Claude Fable 5'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Sonnet 5' }))
    expect(onModelChange).toHaveBeenCalledWith('claude-default', 'claude-sonnet-5')
  })

  it('aggregates models across every enabled provider, qualified by provider name', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: settingsSchema.parse({
        agent: {
          activeInstanceId: 'claude-default',
          providerInstances: {
            'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
            'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
        }
      }),
      resolvedTools: [],
      dataRoot: { path: 'C:/x', fromEnv: false },
      loadError: null
    }))
    const onModelChange = vi.fn()
    render(<Composer disabled={false} onSend={vi.fn()} onModelChange={onModelChange} />)
    fireEvent.click(await screen.findByText('Claude Fable 5 · Claude'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(items).toContain('Auto · Copilot')
    expect(items).toContain('Claude Opus 4.8 · Claude')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto · Copilot' }))
    expect(onModelChange).toHaveBeenCalledWith('copilot-1', 'auto')
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
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    render(<Composer disabled={false} onSend={vi.fn()} />)
    // chip shows the top ordered visible model (favorite pinned first)
    expect(await screen.findByText('Claude Sonnet 5')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Sonnet 5'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(items).toEqual([
      'Claude Sonnet 5',
      'Claude Fable 5',
      'Claude Opus 4.8',
      'Claude Opus 4.7',
      'Claude Sonnet 4.6'
    ])
    expect(items).not.toContain('Claude Haiku 4.5')
  })

  it('derives permission-mode options from the active driver capabilities, not a hardcoded literal', async () => {
    // Both real drivers currently support all four modes — mutate github-copilot's
    // static capabilities to simulate a hypothetical driver that only supports a
    // subset, proving the Composer's picker reads (and filters by) that list
    // rather than always offering Object.values(PERMISSION_MODE_LABELS).
    const original = DRIVERS['github-copilot'].capabilities
    DRIVERS['github-copilot'] = {
      ...DRIVERS['github-copilot'],
      capabilities: { ...original, permissionModes: ['default', 'plan'] as const }
    }
    try {
      window.argus.settings.get = vi.fn(async () => ({
        settings: (() => {
          const s = defaultSettings()
          s.agent.providerInstances['claude-default'].driver = 'github-copilot'
          return s
        })(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      }))
      render(<Composer disabled={false} onSend={vi.fn()} />)
      fireEvent.click(await screen.findByText('Ask approvals'))
      const menu = screen.getByRole('menu', { name: 'Permission mode' })
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent)
      expect(items).toEqual(['Ask approvals', 'Plan mode'])
      expect(items).not.toContain('Auto-approve edits')
      expect(items).not.toContain('Bypass approvals')
    } finally {
      DRIVERS['github-copilot'] = { ...DRIVERS['github-copilot'], capabilities: original }
    }
  })

  it('skill picker offers only enabled skills when typing /', async () => {
    window.argus.skills.list = vi.fn(async () => ({
      skills: [
        {
          name: 'rca',
          tier: 'bundled' as const,
          description: 'Root cause analysis',
          enabled: true,
          shadows: [],
          shadowDiverged: false,
          author: null
        },
        {
          name: 'analyze-applog',
          tier: 'bundled' as const,
          description: 'Analyze Android logs',
          enabled: false,
          shadows: [],
          shadowDiverged: false,
          author: null
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

  describe('skill popup keyboard completion', () => {
    const twoSkills = (): void => {
      window.argus.skills.list = vi.fn(async () => ({
        skills: [
          {
            name: 'rca',
            tier: 'bundled' as const,
            description: 'Root cause',
            enabled: true,
            shadows: [],
            shadowDiverged: false,
            author: null
          },
          {
            name: 'analyze-applog',
            tier: 'bundled' as const,
            description: 'Analyze Android logs',
            enabled: true,
            shadows: [],
            shadowDiverged: false,
            author: null
          }
        ]
      }))
    }

    it('Tab completes the top match', async () => {
      twoSkills()
      render(<Composer disabled={false} onSend={vi.fn()} />)
      const textarea = screen.getByPlaceholderText(/message the analyst/i)
      fireEvent.change(textarea, { target: { value: '/' } })
      await screen.findByText('/rca')
      fireEvent.keyDown(textarea, { key: 'Tab' })
      expect((textarea as HTMLTextAreaElement).value).toBe('/rca ')
    })

    it('arrow keys move the highlight; Tab completes the highlighted skill', async () => {
      twoSkills()
      render(<Composer disabled={false} onSend={vi.fn()} />)
      const textarea = screen.getByPlaceholderText(/message the analyst/i)
      fireEvent.change(textarea, { target: { value: '/' } })
      await screen.findByText('/rca')
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      fireEvent.keyDown(textarea, { key: 'Tab' })
      expect((textarea as HTMLTextAreaElement).value).toBe('/analyze-applog ')
    })

    it('Escape dismisses the popup until the text changes', async () => {
      twoSkills()
      render(<Composer disabled={false} onSend={vi.fn()} />)
      const textarea = screen.getByPlaceholderText(/message the analyst/i)
      fireEvent.change(textarea, { target: { value: '/' } })
      await screen.findByText('/rca')
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(screen.queryByText('/rca')).toBeNull()
      fireEvent.change(textarea, { target: { value: '/r' } })
      expect(await screen.findByText('/rca')).toBeTruthy()
    })

    it('Enter still sends the raw text while the popup is open', async () => {
      twoSkills()
      const onSend = vi.fn()
      render(<Composer disabled={false} onSend={onSend} />)
      const textarea = screen.getByPlaceholderText(/message the analyst/i)
      fireEvent.change(textarea, { target: { value: '/rca' } })
      await screen.findByText('/rca')
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(onSend).toHaveBeenCalledWith('/rca')
    })
  })
})
