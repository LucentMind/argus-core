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

  it('keeps the provider row usable on a Copilot-only install', () => {
    // The resolver's FALLBACK is claude-agent-sdk-only, so this install resolves ok:false —
    // but Copilot is capable and selectable. Disabling here would strand the user with an
    // error above a dropdown they cannot use, which is the state this section removes.
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.providerInstances = {
            'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
        })}
      />
    )
    expect(select('Distillation provider').disabled).toBe(false)
    expect(optionsOf('Distillation provider')).toContain('Copilot')
    fireEvent.change(select('Distillation provider'), { target: { value: 'Copilot' } })
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'github-copilot-1' } }
    })
  })

  it('still lists a pinned model that was later hidden, rather than misreporting Automatic', () => {
    // resolveDistillProvider passes an explicit model through without a visibility check, so
    // the runtime uses it either way — the row must not claim otherwise.
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.distillProvider = {
            instanceId: 'claude-agent-sdk-1',
            model: 'claude-haiku-4-5'
          }
          p.settings.agent.modelPreferences['claude-agent-sdk-1'].hiddenModels.push(
            'claude-haiku-4-5'
          )
        })}
      />
    )
    expect(select('Distillation model').value).toBe('claude-haiku-4-5')
    expect(optionsOf('Distillation model')).toContain('claude-haiku-4-5')
  })

  it('disambiguates two un-renamed instances of the same driver', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.providerInstances['claude-agent-sdk-2'] = {
            driver: 'claude-agent-sdk',
            enabled: true,
            config: {}
          }
        })}
      />
    )
    const opts = optionsOf('Distillation provider')
    expect(opts).toContain('Claude (claude-agent-sdk-1)')
    expect(opts).toContain('Claude (claude-agent-sdk-2)')
    // Selecting the second must pin the SECOND — a label collision would map both to one id.
    fireEvent.change(select('Distillation provider'), {
      target: { value: 'Claude (claude-agent-sdk-2)' }
    })
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'claude-agent-sdk-2' } }
    })
  })

  it('disables both selects and shows the resolver reason when NO instance is capable', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          // Nothing eligible: one disabled instance and one unregistered driver.
          p.settings.agent.providerInstances = {
            'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: false, config: {} },
            'future-1': { driver: 'future-driver', enabled: true, config: {} }
          }
        })}
      />
    )
    expect(select('Distillation provider').disabled).toBe(true)
    expect(select('Distillation model').disabled).toBe(true)
    // getByText throws when absent, so reaching this line is the assertion.
    screen.getByText('no provider configured for distillation')
  })

  it('shows the resolver reason for a stored instance that no longer resolves', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.distillProvider = { instanceId: 'nope' }
        })}
      />
    )
    screen.getByText('distillation provider "nope" is unknown or disabled')
    // The orphaned id must remain visible rather than silently reading as something else.
    expect(select('Distillation provider').value).toBe('nope')
  })
})
