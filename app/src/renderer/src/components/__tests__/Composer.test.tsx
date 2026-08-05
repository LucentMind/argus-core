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
    // the full static catalog is offered, unchanged — no catalog-only row leaked in.
    // Opus 5 is in it, second: the CLI's recommended default used to be unreachable until the
    // catalog landed (and entirely unreachable offline), while row 0 stays Fable 5 so
    // `defaultModelRef` keeps seeding new chats with the same model as before.
    expect(items).toEqual([
      'Claude Fable 5',
      'Claude Opus 5',
      'Claude Opus 4.8',
      'Claude Opus 4.7',
      'Claude Sonnet 5',
      'Claude Sonnet 4.6',
      'Claude Haiku 4.5'
    ])
  })

  it("the runtime catalog leads the session's instance list, surfacing a model the static list lacks — without deleting the built-ins", async () => {
    window.argus.models.catalog = vi.fn(async (instanceId: string) => {
      expect(instanceId).toBe('claude-default')
      return [
        {
          value: 'opus[1m]',
          resolvedModel: 'claude-opus-5[1m]',
          displayName: 'Claude Opus 5 (1M)'
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
    expect(await screen.findByText('Claude Opus 5 (1M)')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Opus 5 (1M)'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // The catalog row leads — but the built-ins it does not name stay selectable. Measured
    // against the real CLI: `supportedModels()` omits Opus 4.8/4.7 and Sonnet 4.6, yet each
    // completes a real turn, so a catalog that replaced this list deleted three usable models
    // from the picker a few seconds after launch. See `mergeBuiltinRows`.
    expect(items[0]).toBe('Claude Opus 5 (1M)')
    expect(items).toContain('Claude Opus 4.7')
    expect(items).toContain('Claude Opus 4.8')
    expect(items).toContain('Claude Sonnet 4.6')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Opus 5 (1M)' }))
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
          displayName: 'Claude Opus 5 (1M)'
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
    fireEvent.click(await screen.findByText('Claude Opus 5 (1M) · Claude'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // Claude's catalog substitutes its own rows...
    expect(items).toContain('Claude Opus 5 (1M) · Claude')
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
    // the row whose resolvedModel is claude-fable-5 — NOT models[0] — named recognisably
    // (Change 2a), not the CLI's own terse alias displayName ("Fable")
    expect(await screen.findByText('Claude Fable 5')).toBeInTheDocument()
    expect(screen.queryByText('Default (recommended)')).not.toBeInTheDocument()
    // ...and the descriptors resolve for THAT row, which is what reaches the wire — surfaced
    // as the fused Traits chip (Change 1) rather than individual Reasoning/Context chips
    expect(screen.getByTitle('Traits')).toBeInTheDocument()
  })

  it('names a pinned model nothing offers instead of showing models[0]', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-opus-4-1')} />
    )
    // Neither the runtime catalog nor the built-in table names this one — and `catalogFor` in
    // the main process likewise resolves nothing, so no run option would reach the wire. The
    // chip must say what the chat is actually pinned to rather than borrow another row's name,
    // and the option chips must be absent, matching what a send would really do.
    expect(await screen.findByText('claude-opus-4-1')).toBeInTheDocument()
    expect(screen.queryByText('Default (recommended)')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Traits')).not.toBeInTheDocument()
  })

  // The other half of that rule, and the reason this fix has a renderer test at all: a built-in
  // the CLI still runs but does not list must resolve to a real row WITH its options. Measured
  // 2026-08-02 — claude-opus-4-8 completes a turn, takes --effort and the [1m] suffix, and is
  // the one model of the three that also reports fast mode.
  it('keeps options on a built-in the runtime catalog omits', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(
      <Composer disabled={false} onSend={vi.fn()} session={pinnedToStaticSlug('claude-opus-4-8')} />
    )
    expect(await screen.findByText('Claude Opus 4.8')).toBeInTheDocument()
    expect(screen.getByTitle('Traits')).toBeInTheDocument()
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
    fireEvent.click(await screen.findByText('Claude Fable 5'))
    const items = within(screen.getByRole('menu', { name: 'Model' }))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // the alias row whose resolvedModel is the hidden wire slug must be gone...
    expect(items).not.toContain('Claude Sonnet 5')
    // ...without taking the rest of the catalog with it
    expect(items).toContain('Claude Fable 5')
    expect(items).toContain('Claude Opus 5 (1M)')
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
    fireEvent.click(await screen.findByText('Claude Fable 5'))
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
      'Claude Opus 5',
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

  // Change 1: replaces the old "renders Reasoning and Context as separate chips, not one
  // fused label" test, which asserted exactly the OLD design (separate per-descriptor chips,
  // no fused label) — the fused chip is now the intended shape, so that assertion is
  // obsolete rather than merely stale. SESSION's model (`claude-fable-5`/`fable`) reports
  // effort, contextWindow and thinking (no fastMode — see the fixture), so the joined label
  // is every one of those three, in descriptor order, at their defaults.
  it('fuses every descriptor into one Traits chip', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    const traits = await screen.findByTitle('Traits')
    // Thinking is deliberately absent: a model that HAS a Reasoning control does not also get
    // a thinking toggle (see descriptorsFor). Fable reports `supportsAdaptiveThinking`, so
    // this asserts the curation, not a capability gap.
    expect(traits).toHaveTextContent('High · 200k')
    expect(traits).not.toHaveTextContent('Thinking')
    // the old per-descriptor chips must be gone, not just relabelled
    expect(screen.queryByTitle('Reasoning')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Context Window')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Thinking')).not.toBeInTheDocument()
  })

  // Change 1, replacing "names the boolean toggle on its chip instead of showing a bare
  // On/Off" (I5): that test asserted Thinking's OWN standalone chip carried its name via
  // `aria-label` — Thinking has no chip of its own any more, it is a section inside the
  // fused Traits popup. The underlying I5 concern (two adjacent booleans reading as bare
  // "Off"/"On" are indistinguishable) still applies to the FUSED label itself, since
  // `Fast Mode` and `Thinking` would otherwise sit side by side there — `TraitsChip` prefixes
  // a boolean's value with its own descriptor label for exactly this reason (see its own doc
  // comment), so this re-expresses the same guarantee against the joined label.
  it('names each boolean value inside the joined Traits label instead of showing a bare On/Off', async () => {
    // Haiku, because it is the model whose only descriptor is a boolean — Fable's booleans
    // are curated away now that it has a Reasoning control.
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={{ ...SESSION, model: 'claude-haiku-4-5' }}
      />
    )
    const traits = await screen.findByTitle('Traits')
    expect(traits).toHaveTextContent('Thinking On')
  })

  // I3: alwaysThinkingEnabled is ON unless explicitly false, so an unset toggle rendering
  // "Off" reported the opposite of what the wire does. Now opens the fused Traits popup
  // (Change 1) instead of a standalone Thinking chip; the Thinking SECTION inside it is the
  // same `OptionSection` the old chip rendered, so its own menuitems are unchanged.
  it('shows Thinking as On by default, matching what the SDK actually does', async () => {
    // Measured 2026-08-03 over an ANTHROPIC_BASE_URL capture: Haiku with nothing set sends
    // `thinking {"type":"enabled","budget_tokens":31999}`, so "On" is the honest default.
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={{ ...SESSION, model: 'claude-haiku-4-5' }}
      />
    )
    await userEvent.click(await screen.findByTitle('Traits'))
    expect(screen.getByRole('menuitem', { name: 'On' })).toHaveClass('text-ink')
    expect(screen.getByRole('menuitem', { name: 'Off' })).toHaveClass('text-dim')
  })

  it('persists only the meaningful half of the Thinking toggle', async () => {
    const onRunOptionsChange = vi.fn()
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={{ ...SESSION, model: 'claude-haiku-4-5' }}
        onRunOptionsChange={onRunOptionsChange}
      />
    )
    await userEvent.click(await screen.findByTitle('Traits'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Off' }))
    expect(onRunOptionsChange).toHaveBeenCalledWith([{ id: 'thinking', value: false }])
  })

  it('gives a model with no Reasoning control a Thinking toggle, and nothing else', async () => {
    render(
      <Composer
        disabled={false}
        onSend={() => {}}
        session={{ ...SESSION, model: 'claude-haiku-4-5' }}
      />
    )
    const traits = await screen.findByTitle('Traits')
    expect(traits).toHaveTextContent('Thinking On')
    await userEvent.click(traits)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument()
    expect(screen.queryByText('Context Window')).not.toBeInTheDocument()
    expect(screen.queryByText('Fast Mode')).not.toBeInTheDocument()
  })

  it('offers Ultracode and Ultrathink in the Reasoning section', async () => {
    render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
    await userEvent.click(await screen.findByTitle('Traits'))
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
    await userEvent.click(await screen.findByTitle('Traits'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
    expect(onRunOptionsChange).toHaveBeenCalledWith([{ id: 'effort', value: 'max' }])
  })

  it('shows no Traits chip for a model that resolves to no capabilities at all', async () => {
    // A non-Claude slug resolves to no ModelOptionInfo, which is the only remaining way to
    // get an empty descriptor list — every Claude model now has at least Thinking.
    render(
      <Composer disabled={false} onSend={() => {}} session={{ ...SESSION, model: 'gpt-5.4' }} />
    )
    await waitFor(() => expect(screen.queryByTitle('Traits')).not.toBeInTheDocument())
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

  /**
   * Synthetic widths for the elements the fit computation measures, close to what the real
   * chips occupy at `text-xs`. jsdom lays nothing out, so without these every element reports
   * `offsetWidth: 0`, the row looks infinitely roomy and collapse can never happen at all.
   *
   * Item widths INCLUDE each item's leading divider, matching how the component measures them
   * (one wrapper per divider+chip pair). With these numbers and the `gap-2` (8px) the fit math
   * adds per slot, the ladder is: >=768 all three, >=684 two, >=536 one, else none.
   */
  const SYNTH_WIDTH: Record<string, number> = {
    traits: 300,
    access: 140,
    toolResults: 114,
    model: 150,
    more: 30,
    send: 32
  }
  let rowWidth = 900

  // Patched on the prototype rather than on specific nodes: collapsing MOVES an item to the
  // ghost row, which remounts it as a brand new element, so any per-node stub would be lost on
  // the first re-render and the row would immediately measure it as 0 and re-expand.
  beforeEach(() => {
    rowWidth = 900
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        const d = this.dataset
        if (d.composerItem) return SYNTH_WIDTH[d.composerItem] ?? 0
        if (d.composerModel !== undefined) return SYNTH_WIDTH.model
        if (d.composerMore !== undefined) return SYNTH_WIDTH.more
        const label = this.getAttribute('aria-label')
        return label === 'Send' || label === 'Stop' ? SYNTH_WIDTH.send : 0
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-composer-density') ? rowWidth : 0
      }
    })
  })

  /** Drives the ResizeObserver the component registers, since jsdom never fires one. */
  function setRowWidth(px: number): void {
    rowWidth = px
    const cb = (globalThis as unknown as { __roCallbacks: ResizeObserverCallback[] }).__roCallbacks
    cb.forEach((c) => c([], {} as ResizeObserver))
  }

  /** How many collapsible controls the row is currently showing. */
  function visibleCount(): number {
    const row = document.querySelector('[data-composer-density]') as HTMLElement
    return Number(row.getAttribute('data-composer-visible'))
  }

  /**
   * Queries scoped to the options row — i.e. to what the user can actually see and click.
   *
   * Needed because a collapsed chip is not unmounted: it keeps rendering inside the `inert`
   * measurement ghost row so its width stays readable (that is what makes the fit computation
   * stable). A global `screen.getByTitle` finds those ghosts, so an unscoped "is it gone?"
   * assertion would silently never fail. The ghosts live OUTSIDE this element for exactly
   * this reason.
   */
  function inRow(): ReturnType<typeof within> {
    return within(document.querySelector('[data-composer-density]') as HTMLElement)
  }

  // Nested here (not a sibling describe) so it inherits this describe's beforeEach,
  // which mocks a catalog with Reasoning/Context descriptors for SESSION's model —
  // without descriptors there is nothing for the collapse to fold.
  describe('Composer responsive collapse', () => {
    it('is wide by default and shows the fused Traits chip', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const row = await screen.findByTestId('composer-options')
      expect(row).toHaveAttribute('data-composer-density', 'wide')
      expect(screen.getByTitle('Traits')).toBeInTheDocument()
    })

    it('collapses everything but Model and Send below the threshold', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'narrow'
      )
      expect(inRow().queryByTitle('Traits')).not.toBeInTheDocument()
      expect(inRow().getByTitle('Model')).toBeInTheDocument()
      expect(inRow().getByLabelText('Send')).toBeInTheDocument()
      expect(inRow().getByLabelText('More options')).toBeInTheDocument()
    })

    it('holds every collapsed control in the one menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      await userEvent.click(inRow().getByLabelText('More options'))
      expect(inRow().getByText('Reasoning')).toBeInTheDocument()
      expect(inRow().getByText('Context Window')).toBeInTheDocument()
      expect(inRow().getByText('Access')).toBeInTheDocument()
      expect(inRow().getByText('Tool results')).toBeInTheDocument()
    })

    it('expands again when the pane widens', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      act(() => setRowWidth(900))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'wide'
      )
      // The attribute flip alone doesn't prove the layout actually restored — confirm a
      // real chip is back in the DOM, not just the density label on the row.
      expect(inRow().getByTitle('Traits')).toBeInTheDocument()
    })

    it('collapsed menu shows only Access and Tool results for a model whose sole option is Thinking', async () => {
      render(
        <Composer
          disabled={false}
          onSend={() => {}}
          session={{ ...SESSION, model: 'claude-haiku-4-5' }}
        />
      )
      // Haiku's one option is Thinking (it has no Reasoning control), so the Traits chip is
      // present but carries a single section.
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      expect(screen.getByTestId('composer-options')).toHaveAttribute(
        'data-composer-density',
        'narrow'
      )
      await userEvent.click(inRow().getByLabelText('More options'))
      expect(inRow().getByText('Thinking')).toBeInTheDocument()
      expect(inRow().getByText('Access')).toBeInTheDocument()
      expect(inRow().getByText('Tool results')).toBeInTheDocument()
      expect(inRow().queryByText('Reasoning')).not.toBeInTheDocument()
      expect(inRow().queryByText('Context Window')).not.toBeInTheDocument()
    })

    it('sheds one control at a time instead of collapsing all of them at once', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      expect(visibleCount()).toBe(3)

      // Tool results goes first, and BOTH survivors stay on the row — this is the whole
      // point: the old fixed threshold folded all three the moment it tripped.
      act(() => setRowWidth(700))
      expect(visibleCount()).toBe(2)
      expect(inRow().getByTitle('Traits')).toBeInTheDocument()
      expect(inRow().getByTitle('Permission mode')).toBeInTheDocument()
      expect(inRow().queryByLabelText(/tool results/i)).not.toBeInTheDocument()

      // Then Access, leaving the Traits chip — the control carrying the most state — last.
      act(() => setRowWidth(600))
      expect(visibleCount()).toBe(1)
      expect(inRow().getByTitle('Traits')).toBeInTheDocument()
      expect(inRow().queryByTitle('Permission mode')).not.toBeInTheDocument()

      act(() => setRowWidth(360))
      expect(visibleCount()).toBe(0)
    })

    it('hands the "…" menu only the controls that are actually hidden', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(700))
      await userEvent.click(inRow().getByLabelText('More options'))
      // Tool results is the only thing collapsed, so it must be the only thing in the menu.
      // Listing a still-visible control here would give one setting two live controls a few
      // pixels apart.
      expect(inRow().getByText('Tool results')).toBeInTheDocument()
      expect(inRow().queryByText('Access')).not.toBeInTheDocument()
      expect(inRow().queryByText('Reasoning')).not.toBeInTheDocument()
    })

    it('keeps Send on the row at every width', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      for (const px of [900, 800, 700, 620, 540, 480, 360, 240]) {
        act(() => setRowWidth(px))
        const used =
          SYNTH_WIDTH.model +
          8 +
          SYNTH_WIDTH.send +
          rowItemWidths(visibleCount()) +
          (visibleCount() < 3 ? 8 + SYNTH_WIDTH.more : 0)
        // The row physically fits what it chose to show — the failure this guards is Send
        // being pushed out of frame, which no DOM query can see on its own.
        expect({ px, used, fits: used <= px || visibleCount() === 0 }).toEqual({
          px,
          used,
          fits: true
        })
      }
    })

    /** Width of the first `n` collapsible items plus the gap that precedes each. */
    function rowItemWidths(n: number): number {
      return ['traits', 'access', 'toolResults']
        .slice(0, n)
        .reduce((sum, id) => sum + 8 + SYNTH_WIDTH[id], 0)
    }
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
      await userEvent.click(await screen.findByTitle('Traits'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Ultrathink' }))
      expect(box).toHaveValue('Ultrathink:\nfix the crash')
      expect(onRunOptionsChange).not.toHaveBeenCalled()
    })

    it('reads its selected state back out of the prompt', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'Ultrathink:\ngo')
      // the Traits chip's joined label carries it — the effort part specifically, per the
      // `labelFor` override (see TraitsChip's own doc comment), not the whole label
      expect(await screen.findByTitle('Traits')).toHaveTextContent('Ultrathink')
    })

    it('strips the prefix when another level is chosen', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const box = screen.getByPlaceholderText(/Message the analyst/)
      await userEvent.type(box, 'Ultrathink:\ngo')
      await userEvent.click(await screen.findByTitle('Traits'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
      expect(box).toHaveValue('go')
    })

    it('locks the section when the word is in the body rather than the prefix', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'please ultrathink')
      await userEvent.click(await screen.findByTitle('Traits'))
      expect(screen.getByText(/Remove it to change this option/i)).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Max' })).toBeDisabled()
    })

    // Supplementary to the brief's tests: the wide chip and the collapsed menu render the
    // same OptionSection, so the lock must hold in the narrow density too, not just the
    // wide chip exercised above.
    it('locks the section in the collapsed menu too, not only the wide chip', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
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
      await userEvent.click(await screen.findByTitle('Traits'))
      expect(screen.getByRole('menuitem', { name: 'Ultrathink' })).toHaveClass('text-ink')
      expect(screen.getByRole('menuitem', { name: 'High' })).toHaveClass('text-dim')
    })

    // Same requirement, collapsed density: TraitsChip and CollapsedMenu render the
    // same OptionSection, so this must not diverge from the wide-chip case above.
    it('highlights Ultrathink as the selected entry in the collapsed menu', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
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
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      await userEvent.type(box, 'Ultrathink:\ngo')
      await userEvent.click(screen.getByLabelText('More options'))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Max' }))
      expect(box).toHaveValue('go')
    })
  })

  // Nested for the same reason as the two describes above: it needs this describe's
  // beforeEach, which mocks a catalog whose model reports a Reasoning descriptor — with no
  // effort descriptor there is no Ultracode to be on.
  //
  // These assert the CLASS only. What that class paints — a marching outline in classic, a
  // filled pill under `.dyn` — is plain CSS in main.css, and jsdom resolves no cascade, so a
  // green run here says the chip is MARKED, never that it looks like anything. The two
  // treatments have to be eyeballed in the running app.
  describe('Composer ultracode chip', () => {
    const ULTRACODE = { ...SESSION, runOptions: [{ id: 'effort', value: 'ultracode' }] }

    it('marks the traits chip when Reasoning is on Ultracode', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={ULTRACODE} />)
      const traits = await screen.findByTitle('Traits')
      expect(traits).toHaveTextContent('Ultracode')
      expect(traits).toHaveClass('argus-ultracode')
    })

    it('leaves the chip unmarked at an ordinary effort level', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      const traits = await screen.findByTitle('Traits')
      expect(traits).toHaveTextContent('High')
      expect(traits).not.toHaveClass('argus-ultracode')
    })

    // Ultrathink relabels this same chip, so a chip reading "Ultrathink" wearing the Ultracode
    // treatment would be claiming a setting the send does not carry — `effectiveEffort` returns
    // undefined while the marker is in the draft.
    it('drops the treatment while Ultrathink owns the label', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={ULTRACODE} />)
      await screen.findByTitle('Traits')
      await userEvent.type(screen.getByPlaceholderText(/Message the analyst/), 'Ultrathink:\ngo')
      const traits = screen.getByTitle('Traits')
      expect(traits).toHaveTextContent('Ultrathink')
      expect(traits).not.toHaveClass('argus-ultracode')
    })

    // A fully collapsed row folds the traits chip away entirely, so the `⋯` trigger has to
    // carry the state instead — otherwise the one thing this feature exists to show is
    // invisible on a narrow pane.
    it('moves the treatment onto the collapsed trigger once the Traits chip is folded away', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={ULTRACODE} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      expect(inRow().queryByTitle('Traits')).not.toBeInTheDocument()
      expect(inRow().getByLabelText('More options')).toHaveClass('argus-ultracode')
    })

    // The `⋯` stands IN for the traits chip, so it may only wear the treatment when that chip
    // is actually gone. Incremental collapse makes "Traits on the row, something else in the
    // menu" the common case, and an unconditional flag put the animated pill on both at once —
    // two Ultracode markers a few pixels apart, reading as two separate states.
    it('leaves the collapsed trigger unmarked while the Traits chip is still on the row', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={ULTRACODE} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(700))
      expect(visibleCount()).toBe(2)
      expect(inRow().getByTitle('Traits')).toHaveClass('argus-ultracode')
      expect(inRow().getByLabelText('More options')).not.toHaveClass('argus-ultracode')
    })

    it('leaves the collapsed trigger unmarked at an ordinary effort level', async () => {
      render(<Composer disabled={false} onSend={() => {}} session={SESSION} />)
      await screen.findByTitle('Traits')
      act(() => setRowWidth(360))
      expect(inRow().getByLabelText('More options')).not.toHaveClass('argus-ultracode')
    })
  })
})

// A prefill is text some OTHER surface staged for this composer: an Analyze
// suggestion, a panel's `sendToAgent`, a related-history citation. In every case
// the staging surface is somewhere else on screen — often a modal covering this
// composer — so the user's half-written sentence must survive the arrival.
describe('Composer prefill', () => {
  const box = (): HTMLTextAreaElement =>
    screen.getByPlaceholderText<HTMLTextAreaElement>('Message the analyst — / for skills')

  it('appends a newly staged draft to text the user already typed', () => {
    const view = render(<Composer disabled={false} onSend={vi.fn()} />)
    fireEvent.change(box(), { target: { value: 'I think this is the same regression —' } })
    view.rerender(
      <Composer disabled={false} onSend={vi.fn()} prefill={'Related history — KAN-5\n'} />
    )
    expect(box().value).toBe('I think this is the same regression —\nRelated history — KAN-5\n')
  })

  it('uses a staged draft as-is when the composer is empty', () => {
    const view = render(<Composer disabled={false} onSend={vi.fn()} />)
    view.rerender(<Composer disabled={false} onSend={vi.fn()} prefill="/analyze-binlog a.binlog" />)
    expect(box().value).toBe('/analyze-binlog a.binlog')
  })
})
