// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ObservabilitySettings } from '../ObservabilitySettings'

const payload = {
  settings: {
    observability: {
      providers: {
        langfuse: { enabled: false, host: '', publicKey: '', captureContent: false },
        otlp: { enabled: false, endpoint: '', protocol: 'http/protobuf', captureContent: false },
        datadog: {
          enabled: false,
          site: 'datadoghq.com',
          mlApp: '',
          env: '',
          captureContent: false
        }
      },
      dashboard: { hiddenCards: [] }
    }
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    settings: { patch: vi.fn().mockResolvedValue(undefined) },
    secrets: { set: vi.fn().mockResolvedValue(undefined), has: vi.fn().mockResolvedValue(false) },
    health: { run: vi.fn().mockResolvedValue(undefined), onResult: vi.fn(() => () => {}) }
  }
})

/** The Test connection button inside one provider's section (found via its Enable switch's
 *  row, then up to the section card), independent of the order sections render in. */
function testButtonOf(label: string): HTMLElement {
  let el: HTMLElement | null = screen.getByLabelText(`Enable ${label}`)
  while (el && !within(el).queryByRole('button', { name: /^(Test connection|Testing…)$/ }))
    el = el.parentElement
  if (!el) throw new Error(`no Test connection button for ${label}`)
  return within(el).getByRole('button', { name: /^(Test connection|Testing…)$/ })
}

describe('ObservabilitySettings', () => {
  // The top bar no longer opens the dashboard directly (user-directed, 2026-08-08) — this
  // button is its only entry point now.
  it('opens the dashboard via the callback', () => {
    const onOpenDashboard = vi.fn()
    render(<ObservabilitySettings payload={payload as never} onOpenDashboard={onOpenDashboard} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }))
    expect(onOpenDashboard).toHaveBeenCalled()
  })

  it('enables Langfuse via a patch', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    const toggle = await screen.findByLabelText(/enable langfuse/i)
    fireEvent.click(toggle)
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        observability: expect.objectContaining({
          providers: expect.objectContaining({
            langfuse: expect.objectContaining({ enabled: true })
          })
        })
      })
    )
  })

  it('shows a content-capture warning', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    expect((await screen.findAllByText(/confidential/i)).length).toBeGreaterThanOrEqual(1)
  })

  it('renders one section per provider, in registry order', () => {
    render(<ObservabilitySettings payload={payload as never} />)
    const dd = screen.getByLabelText('Enable Datadog LLM Observability')
    const lf = screen.getByLabelText('Enable Langfuse')
    const otlp = screen.getByLabelText('Enable OpenTelemetry (OTLP/HTTP)')
    // Registry order: Datadog first, then Langfuse, then OTLP.
    expect(dd.compareDocumentPosition(lf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lf.compareDocumentPosition(otlp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByLabelText('Langfuse Host URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Langfuse Public key')).toBeInTheDocument()
    expect(screen.getByLabelText('Langfuse Secret key')).toBeInTheDocument()
    expect(screen.getByLabelText('OpenTelemetry (OTLP/HTTP) Endpoint')).toBeInTheDocument()
    expect(screen.getByLabelText('OpenTelemetry (OTLP/HTTP) Protocol')).toBeInTheDocument()
  })

  it('enables a provider via a provider-keyed patch', () => {
    render(<ObservabilitySettings payload={payload as never} />)
    fireEvent.click(screen.getByLabelText('Enable OpenTelemetry (OTLP/HTTP)'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      observability: { providers: { otlp: { enabled: true } } }
    })
  })

  it('patches a text field and a select field under their own provider', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    const endpoint = screen.getByLabelText('OpenTelemetry (OTLP/HTTP) Endpoint')
    fireEvent.change(endpoint, { target: { value: ' http://localhost:4318 ' } })
    fireEvent.blur(endpoint)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      observability: { providers: { otlp: { endpoint: 'http://localhost:4318' } } }
    })
    fireEvent.click(screen.getByLabelText('OpenTelemetry (OTLP/HTTP) Protocol'))
    fireEvent.click(await screen.findByRole('option', { name: 'http/json' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      observability: { providers: { otlp: { protocol: 'http/json' } } }
    })
  })

  it('commits a secret under the provider-scoped secret name', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    const input = screen.getByLabelText('OpenTelemetry (OTLP/HTTP) Authorization header')
    fireEvent.change(input, { target: { value: 'Bearer t' } })
    fireEvent.blur(input)
    await vi.waitFor(() =>
      expect(window.argus.secrets.set).toHaveBeenCalledWith(
        'observability/otlp/authorization',
        'Bearer t'
      )
    )
    // Each provider looks up its own secrets on mount.
    expect(window.argus.secrets.has).toHaveBeenCalledWith('observability/langfuse/secret-key')
    expect(window.argus.secrets.has).toHaveBeenCalledWith('observability/otlp/authorization')
  })

  /** Delivers `result` for the OTLP row when the health run is invoked. */
  function deliverOnRun(result: { ok: boolean; detail: string }): ReturnType<typeof vi.fn> {
    const run = window.argus.health.run as ReturnType<typeof vi.fn>
    ;(window.argus.health.onResult as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (r: unknown) => void) => {
        run.mockImplementationOnce(async () => {
          cb({ id: 'observability:otlp', label: 'OTLP', ...result })
        })
        return () => {}
      }
    )
    return run
  }
  const otlpEnabled = {
    settings: {
      observability: {
        ...payload.settings.observability,
        providers: {
          ...payload.settings.observability.providers,
          otlp: { ...payload.settings.observability.providers.otlp, enabled: true }
        }
      }
    }
  }
  const otlpTestButton = (): HTMLElement => testButtonOf('OpenTelemetry (OTLP/HTTP)')

  it("test connection runs the provider's health row and shows the result", async () => {
    const run = deliverOnRun({ ok: true, detail: 'reachable' })
    render(<ObservabilitySettings payload={otlpEnabled as never} />)
    fireEvent.click(otlpTestButton())
    expect(run).toHaveBeenCalledWith(['observability:otlp'])
    const chip = await screen.findByText(/^ok$/i)
    expect(chip).toHaveAttribute('title', 'reachable')
  })

  it('a passing check with a latched export error says so on the chip', async () => {
    const detail = 'exported 1 span · last export error: HTTP 401'
    deliverOnRun({ ok: true, detail })
    render(<ObservabilitySettings payload={otlpEnabled as never} />)
    fireEvent.click(otlpTestButton())
    const chip = await screen.findByText('ok · export error')
    expect(chip).toHaveAttribute('title', detail)
  })

  it('a failing check shows a fail chip whose title is the detail', async () => {
    deliverOnRun({ ok: false, detail: 'not configured: missing endpoint' })
    render(<ObservabilitySettings payload={otlpEnabled as never} />)
    fireEvent.click(otlpTestButton())
    const chip = await screen.findByText(/^fail$/i)
    expect(chip).toHaveAttribute('title', 'not configured: missing endpoint')
  })

  it('test connection is disabled while the provider is disabled', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    expect(otlpTestButton()).toBeDisabled()
    expect(screen.getAllByText(/enable the provider to test it/i).length).toBe(3)
    await act(async () => {}) // let the mount-time secrets.has lookups settle inside act
  })

  it('falls back to a failure when no health result arrives', async () => {
    vi.useFakeTimers()
    try {
      // `run` never settles and never delivers a result.
      ;(window.argus.health.run as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )
      render(<ObservabilitySettings payload={otlpEnabled as never} />)
      fireEvent.click(otlpTestButton())
      expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      const chip = screen.getByText(/^fail$/i)
      expect(chip).toHaveAttribute('title', 'no response from the health check')
      expect(otlpTestButton()).not.toBeDisabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('per-provider capture-content switches patch their own block and show the warning', () => {
    render(<ObservabilitySettings payload={payload as never} />)
    fireEvent.click(screen.getByLabelText('Capture content · Langfuse'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      observability: { providers: { langfuse: { captureContent: true } } }
    })
    expect(screen.getByLabelText('Capture content · OpenTelemetry (OTLP/HTTP)')).toBeInTheDocument()
    expect(screen.getAllByText(/confidential/i).length).toBeGreaterThanOrEqual(2)
  })

  it('renders toggles for the distillation dashboard cards and hides one via a patch', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    expect(await screen.findByLabelText('Show Distillation runs')).toBeInTheDocument()
    expect(screen.getByLabelText('Show Distillation spend')).toBeInTheDocument()
    expect(screen.getByLabelText('Show Failed-run spend')).toBeInTheDocument()
    const toggle = screen.getByLabelText('Show Dry-run spend')
    fireEvent.click(toggle)
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        observability: expect.objectContaining({
          dashboard: expect.objectContaining({
            hiddenCards: expect.arrayContaining(['distill.drySpend'])
          })
        })
      })
    )
  })

  describe('managed by org policy', () => {
    const managedPolicy = {
      present: true,
      path: '/Library/Application Support/Argus/policy.json',
      errors: [],
      observability: {
        datadog: {
          managed: ['enabled', 'site', 'mlApp', 'captureContent', 'api-key'],
          values: {
            enabled: true,
            site: 'datadoghq.eu',
            mlApp: 'argus-org',
            captureContent: false
          },
          identifyUser: false,
          customIntake: false,
          error: null
        }
      }
    }
    const withPolicy = (p: unknown): void => {
      const argus = (window as unknown as { argus: Record<string, unknown> }).argus
      argus.policy = { get: vi.fn().mockResolvedValue(p), onChanged: vi.fn(() => () => {}) }
    }

    it('renders the managed fields and the Enable toggle disabled, with the badge and summary', async () => {
      withPolicy(managedPolicy)
      render(<ObservabilitySettings payload={payload as never} />)
      expect(await screen.findByText('Managed by your organization')).toBeInTheDocument()
      const enable = screen.getByLabelText('Enable Datadog LLM Observability')
      expect(enable).toBeDisabled()
      // The policy's value wins over the user's (off) setting.
      expect(enable).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByLabelText('Datadog LLM Observability Site')).toBeDisabled()
      expect(screen.getByLabelText('Datadog LLM Observability Site')).toHaveTextContent(
        'datadoghq.eu'
      )
      expect(screen.getByLabelText('Datadog LLM Observability ML app')).toBeDisabled()
      expect(screen.getByLabelText('Datadog LLM Observability ML app')).toHaveValue('argus-org')
      expect(screen.getByLabelText('Datadog LLM Observability API key')).toBeDisabled()
      expect(screen.getByLabelText('Datadog LLM Observability API key')).toHaveAttribute(
        'placeholder',
        '•••• (managed)'
      )
      expect(screen.getByLabelText('Capture content · Datadog LLM Observability')).toBeDisabled()
      // Not in the policy → still editable.
      expect(screen.getByLabelText('Datadog LLM Observability Environment')).not.toBeDisabled()
      // Other providers are untouched.
      expect(screen.getByLabelText('Enable Langfuse')).not.toBeDisabled()
      expect(screen.getByTestId('policy-summary-datadog')).toHaveTextContent(
        /sends traces, token usage, cost and scores \(no prompts, responses or tool output\) to Datadog LLM Observability \(datadoghq\.eu\)/
      )
      // Test connection stays available for a managed, enabled provider.
      expect(testButtonOf('Datadog LLM Observability')).not.toBeDisabled()
      fireEvent.click(enable)
      expect(window.argus.settings.patch).not.toHaveBeenCalled()
    })

    it('an invalid policy block says so and shows the provider off', async () => {
      withPolicy({
        ...managedPolicy,
        errors: ['policy: bad'],
        observability: {
          datadog: {
            managed: ['enabled'],
            values: { enabled: false },
            identifyUser: false,
            customIntake: false,
            error: 'policy: bad'
          }
        }
      })
      render(<ObservabilitySettings payload={payload as never} />)
      expect(await screen.findByTestId('policy-summary-datadog')).toHaveTextContent(/invalid/)
      expect(screen.getByLabelText('Enable Datadog LLM Observability')).toBeDisabled()
      expect(screen.getByLabelText('Enable Datadog LLM Observability')).toHaveAttribute(
        'aria-checked',
        'false'
      )
    })

    it('without a policy nothing is locked and no badge renders', async () => {
      withPolicy({ present: false, path: '', errors: [], observability: {} })
      render(<ObservabilitySettings payload={payload as never} />)
      await act(async () => {})
      expect(screen.queryByText('Managed by your organization')).toBeNull()
      expect(screen.getByLabelText('Enable Datadog LLM Observability')).not.toBeDisabled()
    })
  })
})
