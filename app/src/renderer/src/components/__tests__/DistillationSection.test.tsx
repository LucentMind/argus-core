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

/**
 * `SelectField` is a button + `role="listbox"` popup, not a native `<select>` (settingsLayout.tsx
 * explains why). These three keep the assertions below reading the way they did against the
 * native control: `select(x).value` is still the shown value, `optionsOf` still lists the
 * choices, and `choose` still picks one.
 */
function optionsOf(label: string): (string | null)[] {
  const trigger = screen.getByLabelText(label)
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true'
  if (!wasOpen) fireEvent.click(trigger)
  const opts = Array.from(
    screen.getByRole('listbox', { name: label }).querySelectorAll('[role="option"]')
  ).map((o) => o.textContent)
  if (!wasOpen) fireEvent.click(trigger)
  return opts
}

/** Pick an option: open the popup, click the entry. */
function choose(label: string, option: string): void {
  fireEvent.click(screen.getByLabelText(label))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

/** jest-dom isn't wired into a setup file in this project, so renderer tests assert on the
 *  DOM directly (see CaseWorkspace.test.tsx / CaseDashboard.delete.test.tsx). The trigger's
 *  rendered text IS the control's value. */
function select(label: string): { value: string; disabled: boolean } {
  const el = screen.getByLabelText(label) as HTMLButtonElement
  return { value: el.textContent ?? '', disabled: el.disabled }
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
    },
    // The spend row (moved off the Memory page, 2026-08-21) reads this on mount. Zero jobs
    // = no row, which is what every case in this file assumes; the row's own arithmetic is
    // covered in settings/__tests__/DistillationSection.spend.test.tsx.
    usage: {
      stats: vi.fn(async () => ({
        hygiene: { staleDays: 30, minRecalls: 1, trackingStartedAt: '2026-01-01T00:00:00Z' },
        skills: [],
        memory: [],
        references: [],
        archived: [],
        distillation: {
          jobCount: 0,
          totalCostUsd: null,
          failedCostUsd: null,
          avgCostUsd: null,
          avgTurnCount: null,
          avgPromptChars: null
        }
      }))
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
    choose('Distillation provider', 'Copilot')
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'github-copilot-1', model: null } }
    })
  })

  it('omits the model key entirely when there is no stored model to clear', () => {
    render(<DistillationSection payload={payload()} />)
    choose('Distillation provider', 'Copilot')
    // A literal `model: null` here would be written verbatim (no base object to recurse
    // into) and then fail `z.string().optional()` in settingsSchema.parse.
    expect(patchSpy).toHaveBeenCalledWith({
      agent: { distillProvider: { instanceId: 'github-copilot-1' } }
    })
  })

  it('pins the resolved instance when only a model is chosen', () => {
    render(<DistillationSection payload={payload()} />)
    choose('Distillation model', 'claude-haiku-4-5')
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
    choose('Distillation provider', 'Copilot')
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
    choose('Distillation provider', 'Claude (claude-agent-sdk-2)')
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

  it('does not warn when the resolved provider supports agent-based distillation', () => {
    render(<DistillationSection payload={payload()} />)
    expect(
      screen.queryByText(/Agent-based distillation requires a provider with agent support/)
    ).toBeNull()
  })

  it('warns when the selected provider lacks agent support', () => {
    // github-copilot-1 declares headlessOneShot but not headlessAgent — a valid one-shot
    // pick (reference sync, the digest) that cannot run the case-close agent loop.
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.agent.distillProvider = { instanceId: 'github-copilot-1' }
        })}
      />
    )
    screen.getByText(
      'Agent-based distillation requires a provider with agent support (currently Claude). ' +
        'This provider can only run reference sync.'
    )
  })

  it('shows the guidance textarea and commits an edit', () => {
    render(<DistillationSection payload={payload()} />)
    const field = screen.getByLabelText('Distillation guidance') as HTMLTextAreaElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe(
      'Standing instructions for the distiller — e.g. "never propose skills about internal tooling"'
    )
    fireEvent.change(field, { target: { value: 'never propose skills about internal tooling' } })
    fireEvent.blur(field)
    expect(patchSpy).toHaveBeenCalledWith({
      distill: { guidance: 'never propose skills about internal tooling' }
    })
  })

  it('shows the pipeline select defaulting to the single call and offers both pipelines', () => {
    render(<DistillationSection payload={payload()} />)
    expect(select('Distillation pipeline').value).toBe('Single call (v2)')
    expect(optionsOf('Distillation pipeline')).toEqual(['Single call (v2)', 'Staged pipeline (v3)'])
  })

  it('choosing the staged pipeline patches settings.distill.pipeline', () => {
    render(<DistillationSection payload={payload()} />)
    choose('Distillation pipeline', 'Staged pipeline (v3)')
    expect(patchSpy).toHaveBeenCalledWith({ distill: { pipeline: 'v3' } })
  })

  it('reflects a stored v3 pipeline and resets it to the default', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.distill.pipeline = 'v3'
        })}
      />
    )
    expect(select('Distillation pipeline').value).toBe('Staged pipeline (v3)')
    fireEvent.click(screen.getByLabelText('Reset Distillation pipeline'))
    expect(patchSpy).toHaveBeenCalledWith({ distill: { pipeline: null } })
  })

  it('resetting the guidance row clears it', () => {
    render(
      <DistillationSection
        payload={payload((p) => {
          p.settings.distill.guidance = 'watch for X'
        })}
      />
    )
    fireEvent.click(screen.getByLabelText('Reset Distillation guidance'))
    expect(patchSpy).toHaveBeenCalledWith({ distill: { guidance: null } })
  })
})
