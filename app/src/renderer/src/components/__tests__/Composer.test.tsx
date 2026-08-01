// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Composer } from '../Composer'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, settingsSchema } from '../../../../shared/settings'
import { DRIVERS } from '../../../../shared/drivers'
import { clearCatalogStore } from '../../lib/catalogStore'
import type { ModelOptionInfo } from '../../../../shared/runOptions'
import type { SessionSummary } from '../../../../shared/types'
// The REAL captured CLI catalog, not a hand-written approximation of it. Every stub in this
// file used to invent full `claude-*` slugs as the row `value`, which the branch's own
// captured evidence flatly contradicts — the CLI keys rows by ALIAS (`fable`, `sonnet`,
// `haiku`) and reports the wire slug separately as `resolvedModel`. Those stubs are the
// reason fourteen reviews all missed that a session pinned by wire slug matched no row at
// all. Importing the fixture makes that class of divergence impossible to reintroduce.
import CLI_CATALOG from '../../../../main/services/agent/drivers/claude/__fixtures__/models-2-1-220.json'

// jsdom never fires a real ResizeObserver — this stub only needs to capture the callback
// so setRowWidth (below) can drive it by hand; the lifecycle methods are intentionally inert.
/* eslint-disable @typescript-eslint/no-empty-function */
class StubResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    ;(globalThis as unknown as { __roCallbacks: ResizeObserverCallback[] }).__roCallbacks.push(cb)
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
/* eslint-enable @typescript-eslint/no-empty-function */

beforeEach(() => {
  ;(globalThis as unknown as { __roCallbacks: ResizeObserverCallback[] }).__roCallbacks = []
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
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
    expect(screen.getByText('Ask approvals')).toBeTruthy()
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
      return [
        {
          value: 'opus[1m]',
          resolvedModel: 'claude-opus-5[1m]',
          displayName: 'Opus (1M context)'
        }
      ]
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
      return [
        {
          value: 'opus[1m]',
          resolvedModel: 'claude-opus-5[1m]',
          displayName: 'Opus (1M context)'
        }
      ]
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

  // ── C1 regression: alias-keyed catalog vs static-slug pin ──────────────────────────────
  //
  // The runtime catalog keys rows by CLI ALIAS (`fable`, `sonnet`); sessions are pinned by
  // WIRE SLUG (`claude-fable-5`), because defaultModelRef seeds from the static CLAUDE_MODELS
  // list. Matching slug-against-alias never hit, so EVERY chat fell through to models[0] and
  // its chip read "Default (recommended)" — and the descriptor lookup, keyed off that wrong
  // row, disagreed with what the main process resolved for the real pinned model.
  const pinnedToStaticSlug = (model: string): SessionSummary => ({
    id: 1,
    title: '',
    turnCount: 0,
    updatedAt: '',
    driverKind: 'claude-agent-sdk',
    instanceId: 'claude-default',
    model,
    mode: 'investigation',
    runOptions: [],
    permissionMode: null
  })

  it('resolves a session pinned to a STATIC slug against the alias-keyed runtime catalog', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-fable-5')} />
    )
    // the row whose resolvedModel is claude-fable-5 — NOT models[0]
    expect(await screen.findByText('Fable')).toBeInTheDocument()
    expect(screen.queryByText('Default (recommended)')).not.toBeInTheDocument()
    // ...and the descriptors resolve for THAT row, which is what reaches the wire
    expect(screen.getByTitle('Reasoning')).toBeInTheDocument()
    expect(screen.getByTitle('Context Window')).toBeInTheDocument()
  })

  it('names a pinned model the catalog no longer offers instead of showing models[0]', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-opus-4-8')} />
    )
    // The CLI dropped this model, so there is no row for it — and `catalogFor` in the main
    // process likewise resolves nothing, so no run option would reach the wire. The chip must
    // say what the chat is actually pinned to rather than borrow another row's name, and the
    // option chips must be absent, matching what a send would really do.
    expect(await screen.findByText('Claude Opus 4.8')).toBeInTheDocument()
    expect(screen.queryByText('Default (recommended)')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Reasoning')).not.toBeInTheDocument()
  })

  // ── I2 regression: substituting catalog rows used to discard model preferences ──────────
  it('keeps a hidden model hidden once the runtime catalog loads', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: (() => {
        const s = defaultSettings()
        // stored as the WIRE slug, which is all the settings UI ever offered
        s.agent.modelPreferences['claude-default'] = {
          hiddenModels: ['claude-sonnet-5'],
          favoriteModels: [],
          modelOrder: []
        }
        return s
      })(),
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-fable-5')} />
    )
    fireEvent.click(await screen.findByText('Fable'))
    const items = within(screen.getByRole('menu', { name: 'Model' }))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // the alias row whose resolvedModel is the hidden wire slug must be gone...
    expect(items).not.toContain('Sonnet')
    // ...without taking the rest of the catalog with it
    expect(items).toContain('Fable')
    expect(items).toContain('Opus (1M context)')
  })

  it('still offers a custom model for the instance once the runtime catalog loads', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: (() => {
        const s = defaultSettings()
        s.agent.providerInstances['claude-default'].config = { customModels: ['my-internal-model'] }
        return s
      })(),
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-fable-5')} />
    )
    fireEvent.click(await screen.findByText('Fable'))
    const items = within(screen.getByRole('menu', { name: 'Model' }))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(items).toContain('my-internal-model')
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

const SESSION: SessionSummary = {
  id: 1,
  title: '',
  turnCount: 0,
  updatedAt: '',
  driverKind: 'claude-agent-sdk',
  instanceId: 'claude-default',
  model: 'claude-fable-5',
  mode: 'investigation',
  runOptions: [],
  permissionMode: null
}

describe('Composer option chips', () => {
  beforeEach(() => {
    // The real captured CLI catalog. SESSION below is pinned to `claude-fable-5`, a WIRE
    // slug, which resolves to the `fable` ALIAS row through the shared matcher — the exact
    // path C1 broke. The previous stub here invented `value: 'claude-fable-5'`, a shape the
    // CLI never emits, which is precisely why the mismatch survived fourteen reviews.
    window.argus = {
      ...window.argus,
      models: { catalog: async () => CLI_CATALOG as ModelOptionInfo[] },
      skills: { list: async () => ({ skills: [] }) }
    } as never
  })

  it('renders Reasoning and Context as separate chips, not one fused label', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    await waitFor(() => expect(screen.getByTitle('Reasoning')).toBeInTheDocument())
    expect(screen.getByTitle('Context Window')).toBeInTheDocument()
    expect(screen.queryByText('High · 200k')).not.toBeInTheDocument()
  })

  // I5: a boolean chip that rendered only its value was a bare "Off" — and Fast Mode and
  // Thinking sit side by side, so two adjacent chips were indistinguishable without hovering.
  it('names the boolean toggle on its chip instead of showing a bare On/Off', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    const thinking = await screen.findByTitle('Thinking')
    expect(thinking).toHaveTextContent('Thinking')
    // state still reachable, just not as the visible label
    expect(thinking).toHaveAttribute('aria-label', 'Thinking: On')
  })

  // I3: alwaysThinkingEnabled is ON unless explicitly false, so an unset toggle rendering
  // "Off" reported the opposite of what the wire does.
  it('shows Thinking as On by default, matching what the SDK actually does', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    await userEvent.click(await screen.findByTitle('Thinking'))
    expect(screen.getByRole('menuitem', { name: 'On' })).toHaveClass('text-ink')
    expect(screen.getByRole('menuitem', { name: 'Off' })).toHaveClass('text-dim')
  })

  it('persists only the meaningful half of the Thinking toggle', async () => {
    const onRunOptionsChange = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={SESSION}
        onRunOptionsChange={onRunOptionsChange}
      />
    )
    await userEvent.click(await screen.findByTitle('Thinking'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Off' }))
    expect(onRunOptionsChange).toHaveBeenCalledWith([{ id: 'thinking', value: false }])
  })

  it('offers Ultracode and Ultrathink in the Reasoning menu', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    await userEvent.click(await screen.findByTitle('Reasoning'))
    expect(screen.getByRole('menuitem', { name: 'Ultracode' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Ultrathink' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Extra High' })).toBeInTheDocument()
  })

  it('reports a reasoning change to the owner', async () => {
    const onRunOptionsChange = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={SESSION}
        onRunOptionsChange={onRunOptionsChange}
      />
    )
    await userEvent.click(await screen.findByTitle('Reasoning'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
    expect(onRunOptionsChange).toHaveBeenCalledWith([{ id: 'effort', value: 'max' }])
  })

  it('shows no option chips for a model with no descriptors', async () => {
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={{ ...SESSION, model: 'claude-haiku-4-5' }}
      />
    )
    await waitFor(() => expect(screen.queryByTitle('Reasoning')).not.toBeInTheDocument())
    expect(screen.queryByTitle('Context Window')).not.toBeInTheDocument()
  })

  it('reports a permission change to the owner', async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={SESSION}
        onPermissionModeChange={onPermissionModeChange}
      />
    )
    await userEvent.click(await screen.findByTitle('Permission mode'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Auto-approve edits' }))
    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits')
  })

  /** Drives the ResizeObserver the component registers, since jsdom never fires one. */
  function setRowWidth(px: number): void {
    const cb = (globalThis as unknown as { __roCallbacks: ResizeObserverCallback[] }).__roCallbacks
    const row = document.querySelector('[data-composer-density]') as HTMLElement
    Object.defineProperty(row, 'clientWidth', { value: px, configurable: true })
    cb.forEach((c) => c([], {} as ResizeObserver))
  }

  // Nested here (not a sibling describe) so it inherits this describe's beforeEach,
  // which mocks a catalog with Reasoning/Context descriptors for SESSION's model —
  // without descriptors there is nothing for the collapse to fold.
  describe('Composer responsive collapse', () => {
    it('is wide by default and shows each chip separately', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const row = await screen.findByTestId('composer-options')
      expect(row).toHaveAttribute('data-composer-density', 'wide')
      expect(screen.getByTitle('Reasoning')).toBeInTheDocument()
    })

    it('collapses everything but Model and Send below the threshold', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'narrow'
      )
      expect(screen.queryByTitle('Reasoning')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Context Window')).not.toBeInTheDocument()
      expect(screen.getByTitle('Model')).toBeInTheDocument()
      expect(screen.getByLabelText('Send')).toBeInTheDocument()
      expect(screen.getByLabelText('More options')).toBeInTheDocument()
    })

    it('holds every collapsed control in the one menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      await userEvent.click(screen.getByLabelText('More options'))
      expect(screen.getByText('Reasoning')).toBeInTheDocument()
      expect(screen.getByText('Context Window')).toBeInTheDocument()
      expect(screen.getByText('Access')).toBeInTheDocument()
      expect(screen.getByText('Tool results')).toBeInTheDocument()
    })

    it('expands again when the pane widens', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      act(() => setRowWidth(900))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'wide'
      )
      // The attribute flip alone doesn't prove the layout actually restored — confirm a
      // real chip is back in the DOM, not just the density label on the row.
      expect(screen.getByTitle('Reasoning')).toBeInTheDocument()
    })

    it('collapsed menu still shows Access and Tool results — but no descriptor sections — for a model with none', async () => {
      render(
        <Composer
          disabled={false}
          onSend={() => {}}
          session={{ ...SESSION, model: 'claude-haiku-4-5' }}
        />
      )
      // Haiku has no descriptors, so there's no Reasoning chip to await — flush the
      // catalog-load effect via a negative assertion instead, as the sibling test above does.
      await waitFor(() => expect(screen.queryByTitle('Reasoning')).not.toBeInTheDocument())
      act(() => setRowWidth(360))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'narrow'
      )
      await userEvent.click(screen.getByLabelText('More options'))
      expect(screen.getByText('Access')).toBeInTheDocument()
      expect(screen.getByText('Tool results')).toBeInTheDocument()
      expect(screen.queryByText('Reasoning')).not.toBeInTheDocument()
      expect(screen.queryByText('Context Window')).not.toBeInTheDocument()
    })
  })

  // Nested here (not a sibling describe) for the same reason as 'Composer responsive
  // collapse' above: it needs this describe's beforeEach, which mocks a catalog with
  // Reasoning descriptors for SESSION's model — without a Reasoning chip there is
  // nothing for Ultrathink to toggle.
  describe('Composer ultrathink', () => {
    it('writes the prefix into the draft instead of storing a selection', async () => {
      const onRunOptionsChange = vi.fn()
      render(
        <Composer
          disabled={false}
          onSend={() => {}}
          session={SESSION}
          onRunOptionsChange={onRunOptionsChange}
        />
      )
      const box = screen.getByPlaceholderText(/Message the analyst/)
      await userEvent.type(box, 'fix the crash')
      await userEvent.click(await screen.findByTitle('Reasoning'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Ultrathink' }))
      expect(box).toHaveValue('Ultrathink:\nfix the crash')
      expect(onRunOptionsChange).not.toHaveBeenCalled()
    })

    it('reads its selected state back out of the prompt', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'Ultrathink:\ngo')
      expect(await screen.findByTitle('Reasoning')).toHaveTextContent('Ultrathink')
    })

    it('strips the prefix when another level is chosen', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const box = screen.getByPlaceholderText(/Message the analyst/)
      await userEvent.type(box, 'Ultrathink:\ngo')
      await userEvent.click(await screen.findByTitle('Reasoning'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
      expect(box).toHaveValue('go')
    })

    it('locks the section when the word is in the body rather than the prefix', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'please ultrathink')
      await userEvent.click(await screen.findByTitle('Reasoning'))
      expect(screen.getByText(/Remove it to change this option/i)).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Max' })).toBeDisabled()
    })

    // Supplementary to the brief's tests: the wide chip and the collapsed menu render the
    // same OptionSection, so the lock must hold in the narrow density too, not just the
    // wide chip exercised above.
    it('locks the section in the collapsed menu too, not only the wide chip', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'please ultrathink')
      await userEvent.click(screen.getByLabelText('More options'))
      expect(screen.getByText(/Remove it to change this option/i)).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Max' })).toBeDisabled()
    })

    // Finding 1: the trigger label reading "Ultrathink" is not enough — the open menu's
    // highlighted entry must also move off the last stored real effort level (here the
    // 'high' default) and onto Ultrathink itself, in the wide chip's own popup.
    it('highlights Ultrathink as the selected entry in the wide chip menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'Ultrathink:\ngo')
      await userEvent.click(await screen.findByTitle('Reasoning'))
      expect(screen.getByRole('menuitem', { name: 'Ultrathink' })).toHaveClass('text-ink')
      expect(screen.getByRole('menuitem', { name: 'High' })).toHaveClass('text-dim')
    })

    // Same requirement, collapsed density: DescriptorChip and CollapsedMenu render the
    // same OptionSection, so this must not diverge from the wide-chip case above.
    it('highlights Ultrathink as the selected entry in the collapsed menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'Ultrathink:\ngo')
      await userEvent.click(screen.getByLabelText('More options'))
      expect(screen.getByRole('menuitem', { name: 'Ultrathink' })).toHaveClass('text-ink')
      expect(screen.getByRole('menuitem', { name: 'High' })).toHaveClass('text-dim')
    })

    // Finding 2: symmetric to 'strips the prefix when another level is chosen' above,
    // but through the collapsed `⋯` menu — the two densities are required to behave
    // identically, and only the wide-chip case was covered before.
    it('strips the prefix when another level is chosen from the collapsed menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const box = screen.getByPlaceholderText(/Message the analyst/)
      await screen.findByTitle('Reasoning')
      act(() => setRowWidth(360))
      await userEvent.type(box, 'Ultrathink:\ngo')
      await userEvent.click(screen.getByLabelText('More options'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
      expect(box).toHaveValue('go')
    })
  })
})
