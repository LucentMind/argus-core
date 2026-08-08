// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderModels } from '../settings/ProviderModels'
import { defaultSettings, type AppSettings } from '../../../../shared/settings'
import { clearCatalogStore } from '../../lib/catalogStore'
import type { ModelOptionInfo } from '../../../../shared/runOptions'
// The real captured CLI catalog — same fixture Composer.test.tsx and modelIdentity.test.ts use,
// so Change 3's "same rows the composer offers" claim is proven against real data.
import CLI_CATALOG from '../../../../main/services/agent/drivers/claude/__fixtures__/models-2-1-220.json'

function settings(mut?: (s: AppSettings) => void): AppSettings {
  const s = defaultSettings()
  mut?.(s)
  return s
}

beforeEach(() => {
  clearCatalogStore()
  window.argus = {
    settings: {
      patch: vi.fn(async () => defaultSettings())
    },
    // Empty by default: the panel falls back to the static catalog, which is what every
    // existing test here asserts against. The dedicated runtime-catalog tests below override
    // this per-case (see Change 2/3: `ProviderModels` now fetches the same runtime catalog the
    // composer's picker does, for a Claude instance).
    models: { catalog: vi.fn(async () => []) }
  } as never
})

describe('ProviderModels', () => {
  it('renders the built-in catalog with a count header', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    expect(screen.getByText('Models · 7 available')).toBeTruthy()
    expect(screen.getByText('Claude Fable 5')).toBeTruthy()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
  })

  it('starring a model favorites it and patches modelPreferences', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    fireEvent.click(screen.getByLabelText('Add Claude Sonnet 5 to favorites'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        modelPreferences: {
          'claude-default': {
            hiddenModels: [],
            favoriteModels: ['claude-sonnet-5'],
            modelOrder: []
          }
        }
      }
    })
  })

  it('unstarring the only favorite sends null (all-empty prefs collapse to absent entry)', () => {
    const s = settings((s) => {
      s.agent.modelPreferences['claude-default'] = {
        hiddenModels: [],
        favoriteModels: ['claude-sonnet-5'],
        modelOrder: []
      }
    })
    render(<ProviderModels settings={s} instanceId="claude-default" />)
    fireEvent.click(screen.getByLabelText('Remove Claude Sonnet 5 from favorites'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { modelPreferences: { 'claude-default': null } }
    })
  })

  it('hiding a model patches hiddenModels and renders it struck-through with a hidden chip', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    fireEvent.click(screen.getByLabelText('Hide Claude Haiku 4.5'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        modelPreferences: {
          'claude-default': {
            hiddenModels: ['claude-haiku-4-5'],
            favoriteModels: [],
            modelOrder: []
          }
        }
      }
    })
  })

  it('struck-through + hidden chip appear once hiddenModels includes the slug', () => {
    const s = settings((s) => {
      s.agent.modelPreferences['claude-default'] = {
        hiddenModels: ['claude-haiku-4-5'],
        favoriteModels: [],
        modelOrder: []
      }
    })
    render(<ProviderModels settings={s} instanceId="claude-default" />)
    const row = screen.getByText('Claude Haiku 4.5')
    expect(row.className).toMatch(/line-through/)
    expect(screen.getByText('hidden')).toBeTruthy()
  })

  it('moving a model down swaps it with its neighbor and patches the full ordered slug array', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    fireEvent.click(screen.getByLabelText('Move Claude Fable 5 down'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        modelPreferences: {
          'claude-default': {
            hiddenModels: [],
            favoriteModels: [],
            modelOrder: [
              'claude-opus-5',
              'claude-fable-5',
              'claude-opus-4-8',
              'claude-opus-4-7',
              'claude-sonnet-5',
              'claude-sonnet-4-6',
              'claude-haiku-4-5'
            ]
          }
        }
      }
    })
  })

  it('the first row cannot move up and the last row cannot move down', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    expect((screen.getByLabelText('Move Claude Fable 5 up') as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(
      (screen.getByLabelText('Move Claude Haiku 4.5 down') as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('adding a custom model patches the instance config envelope', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    fireEvent.change(screen.getByLabelText('Add custom model slug'), {
      target: { value: 'my-custom-model' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: {
          'claude-default': { config: { customModels: ['my-custom-model'] } }
        }
      }
    })
  })

  it('rejects an empty slug, a built-in duplicate, an over-length slug, and a duplicate custom slug', () => {
    const s = settings((s) => {
      s.agent.providerInstances['claude-default'].config = { customModels: ['my-custom-model'] }
    })
    render(<ProviderModels settings={s} instanceId="claude-default" />)
    const input = screen.getByLabelText('Add custom model slug')
    const add = screen.getByRole('button', { name: 'Add' })

    fireEvent.click(add)
    expect(screen.getByText('Enter a model slug.')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'claude-fable-5' } })
    fireEvent.click(add)
    expect(screen.getByText('That model is already built in.')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'x'.repeat(101) } })
    fireEvent.click(add)
    expect(screen.getByText('Model slugs must be 100 characters or less.')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'my-custom-model' } })
    fireEvent.click(add)
    expect(screen.getByText('That custom model is already saved.')).toBeTruthy()
  })

  it('removing a custom model patches config and scrubs it from order/favorites', () => {
    const s = settings((s) => {
      s.agent.providerInstances['claude-default'].config = { customModels: ['my-custom-model'] }
      s.agent.modelPreferences['claude-default'] = {
        hiddenModels: [],
        favoriteModels: ['my-custom-model'],
        modelOrder: ['my-custom-model', 'claude-fable-5']
      }
    })
    render(<ProviderModels settings={s} instanceId="claude-default" />)
    fireEvent.click(screen.getByLabelText('Remove my-custom-model'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: { 'claude-default': { config: { customModels: [] } } }
      }
    })
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        modelPreferences: {
          'claude-default': { hiddenModels: [], favoriteModels: [], modelOrder: ['claude-fable-5'] }
        }
      }
    })
  })
})

// ── Change 3: the runtime catalog, merged into the static list, for a Claude instance ──────
//
// Before this the panel always rendered `instanceModels`/`orderedModels` — the driver's
// static `CLAUDE_MODELS` catalog — even once a live catalog had loaded elsewhere in the app,
// so Settings and the composer's model chip could name entirely different sets of models
// (no Opus 5 here at all). It then briefly went the other way, substituting the catalog and
// dropping the built-ins it omits; measured 2026-08-02, those are still real models the CLI
// runs, so the panel now shows the union — and must show the SAME set the picker does, or
// there is a model the user can select but cannot hide, favourite or reorder.
describe('ProviderModels runtime catalog (Claude instance)', () => {
  it('renders the same recognisable, deduped names the composer picker uses once the catalog loads', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    // 5 fixture rows, `default`/`opus[1m]` deduped to one -> 4, plus the 3 built-ins the
    // fixture's alias menu never names (fable/sonnet/haiku already cover their built-ins)
    expect(await screen.findByText('Models · 7 available')).toBeTruthy()
    expect(screen.getByText('Claude Opus 5')).toBeTruthy()
    expect(screen.getByText('Claude Fable 5')).toBeTruthy()
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('Claude Opus 4.7')).toBeTruthy()
    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy()
    // the terse CLI aliases must not leak into this panel either
    expect(screen.queryByText('Default (recommended)')).toBeNull()
    expect(screen.queryByText('Opus (1M context)')).toBeNull()
    expect(screen.queryByText('Fable')).toBeNull()
    expect(screen.queryByText('Sonnet')).toBeNull()
    // and the dedupe really did collapse to one row, not just hide a duplicate visually
    expect(screen.getAllByText('Claude Opus 5')).toHaveLength(1)
  })

  it('a non-Claude instance keeps its static catalog unchanged, even if a catalog fetch is mocked', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    const s = settings((s) => {
      s.agent.providerInstances['copilot-1'] = {
        driver: 'github-copilot',
        enabled: true,
        config: {}
      }
    })
    render(<ProviderModels settings={s} instanceId="copilot-1" />)
    expect(await screen.findByText('Models · 1 available')).toBeTruthy()
    expect(screen.getByText('Auto')).toBeTruthy()
    expect(window.argus.models.catalog).not.toHaveBeenCalled()
  })

  it("hiding a catalog row patches hiddenModels with the ROW's own (alias) slug", async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    // Wait for a name only the loaded catalog can produce (the static fallback also renders
    // a "Claude Haiku 4.5" row before the catalog resolves) — otherwise `findByLabelText`
    // below can resolve against the STATIC list's button, which is then unmounted out from
    // under the click once the catalog effect lands.
    await screen.findByText('Claude Opus 5')
    fireEvent.click(screen.getByLabelText('Hide Claude Haiku 4.5'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        modelPreferences: {
          'claude-default': { hiddenModels: ['haiku'], favoriteModels: [], modelOrder: [] }
        }
      }
    })
  })

  it('translates a preference stored as the OLD static wire slug onto the loaded alias row', async () => {
    const s = settings((s) => {
      // stored back when the panel only ever offered the static list
      s.agent.modelPreferences['claude-default'] = {
        hiddenModels: ['claude-sonnet-5'],
        favoriteModels: [],
        modelOrder: []
      }
    })
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(<ProviderModels settings={s} instanceId="claude-default" />)
    // Settle on the loaded catalog first (see the previous test's comment: the static
    // fallback also has a row literally named "Claude Sonnet 5", which would let this
    // assertion pass by coincidence against the PRE-catalog render instead of actually
    // exercising translatePreferences against the alias-keyed row).
    await screen.findByText('Claude Opus 5')
    const row = screen.getByText('Claude Sonnet 5')
    expect(row.className).toMatch(/line-through/)
    expect(screen.getByText('hidden')).toBeTruthy()
  })

  it('rejects a custom slug that duplicates a loaded catalog row by wire slug, not just by alias', async () => {
    window.argus.models.catalog = vi.fn(async () => CLI_CATALOG as ModelOptionInfo[])
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    // Settle on the loaded catalog first — see the earlier tests' comment on why a
    // catalog-only name (not "Claude Fable 5", which the static fallback also renders) is
    // the right thing to wait for here.
    await screen.findByText('Claude Opus 5')
    // the row's own slug is the alias `fable`; a user typing the wire slug this alias
    // resolves to must still be caught as a duplicate, not silently accepted then dropped
    fireEvent.change(screen.getByLabelText('Add custom model slug'), {
      target: { value: 'claude-fable-5' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('That model is already built in.')).toBeTruthy()
  })
})
