// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DistillationSection } from '../settings/DistillationSection'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

/** Mirrors the real install that exposed the problem: an enabled claude-agent-sdk instance
 *  with an empty config and two models hidden, so the resolver falls through to the top of
 *  the catalog (claude-fable-5). */
function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  p.settings.agent.activeInstanceId = 'github-copilot-1'
  p.settings.agent.providerInstances = {
    'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
    'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
  }
  p.settings.agent.modelPreferences = {
    'claude-agent-sdk-1': {
      hiddenModels: ['claude-sonnet-4-6', 'claude-opus-4-7'],
      favoriteModels: [],
      modelOrder: []
    }
  }
  mut?.(p)
  return p
}

function optionsOf(label: string): (string | null)[] {
  return Array.from(screen.getByLabelText(label).querySelectorAll('option')).map(
    (o) => o.textContent
  )
}

/** jest-dom isn't wired into a setup file in this project, so renderer tests assert on the
 *  DOM directly (see CaseWorkspace.test.tsx / CaseDashboard.delete.test.tsx). */
function select(label: string): HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLSelectElement
}

let patchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  settingsStore.reset()
  patchSpy = vi.fn(async () => payload())
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: patchSpy,
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('DistillationSection', () => {
  it('shows the RESOLVED default when nothing is set — the whole point of the section', () => {
    render(<DistillationSection payload={payload()} />)
    expect(select('Distillation provider').value).toBe('Automatic (Claude)')
    expect(select('Distillation model').value).toBe('Automatic (claude-fable-5)')
  })

  it('offers only enabled, headless-capable instances', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.providerInstances['claude-agent-sdk-2'] = {
            driver: 'claude-agent-sdk',
            enabled: false,
            config: {}
          }
          p.settings.agent.providerInstances['future-1'] = {
            driver: 'future-driver',
            enabled: true,
            config: {}
          }
        })}
      />
    )
    // Copilot IS eligible (it declares headlessOneShot); the disabled instance and the
    // unregistered driver are not. Order follows Object.entries of providerInstances, and
    // the fixture declares github-copilot-1 first.
    expect(optionsOf('Distillation provider')).toEqual(['Automatic (Claude)', 'Copilot', 'Claude'])
  })

  it('uses the instance displayName when one is set', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.providerInstances['claude-agent-sdk-1'].displayName = 'Work account'
        })}
      />
    )
    expect(optionsOf('Distillation provider')).toContain('Work account')
  })

  it('clears a stale model when the provider changes', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.distillProvider = {
            instanceId: 'claude-agent-sdk-1',
            model: 'claude-haiku-4-5'
          }
        })}
      />
    )
    fireEvent.change(screen.getByLabelText('Distillation provider'), {
      target: { value: 'Copilot' }
    })
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'github-copilot-1', model: null } }
    })
  })

  it('omits the model key entirely when there is no stored model to clear', () => {
    render(<DistillationSection payload={payload()} />)
    fireEvent.change(screen.getByLabelText('Distillation provider'), {
      target: { value: 'Copilot' }
    })
    // A literal `model: null` here would be written verbatim (no base object to recurse
    // into) and then fail `z.string().optional()` in settingsSchema.parse.
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'github-copilot-1' } }
    })
  })

  it('pins the resolved instance when only a model is chosen', () => {
    render(<DistillationSection payload={payload()} />)
    fireEvent.change(screen.getByLabelText('Distillation model'), {
      target: { value: 'claude-haiku-4-5' }
    })
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'claude-agent-sdk-1', model: 'claude-haiku-4-5' } }
    })
  })

  it('resetting the provider row returns everything to Automatic', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.distillProvider = {
            instanceId: 'claude-agent-sdk-1',
            model: 'claude-haiku-4-5'
          }
        })}
      />
    )
    fireEvent.click(screen.getByLabelText('Reset Distillation provider'))
    expect(patchSpy).toHaveBeenCalledWith({ agent: { distillProvider: null } })
  })

  it('disables both selects and shows the resolver reason when nothing can distill', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.providerInstances = {
            'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
          p.settings.agent.distillProvider = { instanceId: 'nope' }
        })}
      />
    )
    expect(select('Distillation provider').disabled).toBe(true)
    expect(select('Distillation model').disabled).toBe(true)
    // getByText throws when absent, so reaching this line is the assertion.
    screen.getByText('distillation provider "nope" is unknown or disabled')
  })
})
