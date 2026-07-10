// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderModels } from '../settings/ProviderModels'
import { defaultSettings, type AppSettings } from '../../../../shared/settings'

function settings(mut?: (s: AppSettings) => void): AppSettings {
  const s = defaultSettings()
  mut?.(s)
  return s
}

beforeEach(() => {
  window.argus = {
    settings: {
      patch: vi.fn(async () => defaultSettings())
    }
  } as never
})

describe('ProviderModels', () => {
  it('renders the built-in catalog with a count header', () => {
    render(<ProviderModels settings={settings()} instanceId="claude-default" />)
    expect(screen.getByText('Models · 6 available')).toBeTruthy()
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
              'claude-opus-4-8',
              'claude-fable-5',
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
