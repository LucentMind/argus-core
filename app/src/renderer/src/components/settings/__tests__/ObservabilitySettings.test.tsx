// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ObservabilitySettings } from '../ObservabilitySettings'

const payload = {
  settings: {
    observability: {
      providers: {
        langfuse: { enabled: false, host: '', publicKey: '', captureContent: false },
        otlp: { enabled: false, endpoint: '', protocol: 'http/protobuf', captureContent: false }
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
    const lf = screen.getByLabelText('Enable Langfuse')
    const otlp = screen.getByLabelText('Enable OpenTelemetry (OTLP/HTTP)')
    expect(lf).toBeInTheDocument()
    expect(otlp).toBeInTheDocument()
    // Registry order: Langfuse's section precedes OTLP's in the document.
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
  const otlpTestButton = (): HTMLElement =>
    screen.getAllByRole('button', { name: 'Test connection' })[1]

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
    expect(screen.getAllByText(/enable the provider to test it/i).length).toBe(2)
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
})
