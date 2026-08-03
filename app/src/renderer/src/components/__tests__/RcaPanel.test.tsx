// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RcaPanel } from '../RcaPanel'
import { buildAssignments } from '../../lib/rcaDraft'
import { confirm } from '../../lib/confirmStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { RcaDraft, RcaJobRow, RcaStatusPayload } from '../../../../shared/rca'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

function settingsPayload(over: Partial<SettingsPayload['settings']['rca']> = {}): SettingsPayload {
  const s = defaultSettings()
  return {
    settings: { ...s, rca: { ...s.rca, ...over } },
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

function draft(over: Partial<RcaDraft> = {}): RcaDraft {
  return {
    rootCause: {
      findingId: 1,
      statement: 'the cache key omitted the tenant id',
      evidence: [{ path: 'logs/app.log', line: 12, evidence: 'cache hit for wrong tenant' }]
    },
    contributing: [{ findingId: 2, statement: 'no tenant-scoping test existed', evidence: [] }],
    symptoms: [{ findingId: 3, statement: 'customers saw other tenants data' }],
    ruledOut: [],
    duplicates: [],
    impact: 'cross-tenant data leak in cached responses',
    timeline: [],
    remediation: { immediate: 'invalidate cache', followUps: ['add tenant id to cache key'] },
    execSummary: {
      whatBroke: 'cached data leaked between tenants',
      impact: 'customers saw other tenants data',
      why: 'the cache key omitted the tenant id',
      nextSteps: 'add tenant id to the cache key'
    },
    techNarrative: [],
    ...over
  }
}

function job(over: Partial<RcaJobRow> = {}): RcaJobRow {
  return {
    id: 7,
    caseSlug: 'NAV-1',
    state: 'done',
    error: null,
    confirmedAt: null,
    postResults: null,
    createdAt: '2026-08-01T00:00:00Z',
    finishedAt: '2026-08-01T00:00:05Z',
    ...over
  }
}

function payloadFor(j: RcaJobRow | null, d: RcaDraft | null = null): RcaStatusPayload {
  return { caseSlug: 'NAV-1', job: j, draft: d }
}

const generate = vi.fn()
const status = vi.fn()
const confirmIpc = vi.fn()
const post = vi.fn()
const renderPreview = vi.fn()
const findingsList = vi.fn()
let rcaChangedCb: ((p: RcaStatusPayload) => void) | null = null

beforeEach(() => {
  rcaChangedCb = null
  generate.mockReset().mockResolvedValue(job({ state: 'queued' }))
  status.mockReset()
  confirmIpc.mockReset().mockResolvedValue(undefined)
  post.mockReset()
  renderPreview.mockReset().mockResolvedValue({ exec: '# exec preview', tech: '# tech preview' })
  findingsList.mockReset().mockResolvedValue([
    { id: 1, mode: 'investigation' },
    { id: 2, mode: 'investigation' },
    { id: 3, mode: 'investigation' }
  ])
  vi.mocked(confirm).mockReset().mockResolvedValue(true)

  window.argus = {
    rca: {
      generate,
      status,
      confirm: confirmIpc,
      post,
      renderPreview,
      onRcaChanged: vi.fn((cb: (p: RcaStatusPayload) => void) => {
        rcaChangedCb = cb
        return () => {
          rcaChangedCb = null
        }
      })
    },
    findings: { list: findingsList },
    settings: { get: vi.fn(async () => settingsPayload()), onChanged: vi.fn(() => () => {}) }
  } as never
  settingsStore.reset()
})

describe('buildAssignments (pure)', () => {
  it('assigns every non-null findingId to its section role', () => {
    const d = draft()
    expect(buildAssignments(d, new Set())).toEqual(
      expect.arrayContaining([
        { findingId: 1, role: 'root-cause' },
        { findingId: 2, role: 'contributing' },
        { findingId: 3, role: 'symptom' }
      ])
    )
  })

  it('excludes a vetoed duplicate from the assignment set', () => {
    const d = draft({ duplicates: [{ findingId: 5, ofFindingId: 1 }] })
    expect(buildAssignments(d, new Set())).toEqual(
      expect.arrayContaining([{ findingId: 5, role: 'duplicate' }])
    )
    expect(buildAssignments(d, new Set([5]))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ findingId: 5 })])
    )
  })

  it('a role already claimed for a finding id is not overwritten by a later section', () => {
    // finding 1 is both the root cause and (erroneously) listed as contributing —
    // the first `put` wins.
    const d = draft({
      contributing: [...draft().contributing, { findingId: 1, statement: 'dup', evidence: [] }]
    })
    const out = buildAssignments(d, new Set())
    expect(out.filter((a) => a.findingId === 1)).toEqual([{ findingId: 1, role: 'root-cause' }])
  })
})

describe('RcaPanel', () => {
  it('shows Generate when there is no job', async () => {
    status.mockResolvedValue(payloadFor(null))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /generate rca report/i })).toBeInTheDocument()
  })

  it('shows a progress note while the job is running', async () => {
    status.mockResolvedValue(payloadFor(job({ state: 'running' })))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/generating/i)).toBeInTheDocument())
  })

  it('shows claim cards when the job is done', async () => {
    status.mockResolvedValue(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    expect(await screen.findByText('the cache key omitted the tenant id')).toBeInTheDocument()
    expect(screen.getByText('no tenant-scoping test existed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /confirm & freeze/i })).toBeInTheDocument()
  })

  it('disables Generate with a tooltip when the case has no investigation findings', async () => {
    findingsList.mockResolvedValue([])
    status.mockResolvedValue(payloadFor(null))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    const btn = await screen.findByRole('button', { name: /generate rca report/i })
    await waitFor(() => expect(btn).toBeDisabled())
  })

  it('parse-failed job shows the error and a Regenerate button', async () => {
    status.mockResolvedValue(
      payloadFor(job({ state: 'failed', error: 'model returned invalid JSON' }))
    )
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    expect(await screen.findByText(/model returned invalid json/i)).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /regenerate/i })
    await userEvent.click(btn)
    expect(generate).toHaveBeenCalledWith('NAV-1')
  })

  it('role select per claim card builds the assignment set; confirm calls IPC with it', async () => {
    status.mockResolvedValue(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('no tenant-scoping test existed')

    const select = screen.getByRole('combobox', { name: /role for finding 2/i })
    await userEvent.selectOptions(select, 'ruled-out')

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))

    await waitFor(() => expect(confirmIpc).toHaveBeenCalledTimes(1))
    expect(confirmIpc).toHaveBeenCalledWith(
      'NAV-1',
      7,
      expect.arrayContaining([{ findingId: 2, role: 'ruled-out' }]),
      expect.objectContaining({ rootCause: expect.anything() })
    )
  })

  it('duplicate rows can be vetoed (vetoed pair produces no duplicate role)', async () => {
    status.mockResolvedValue(
      payloadFor(job(), draft({ duplicates: [{ findingId: 9, ofFindingId: 1 }] }))
    )
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    const checkbox = await screen.findByRole('checkbox', { name: /veto duplicate finding 9/i })
    await userEvent.click(checkbox)

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await waitFor(() => expect(confirmIpc).toHaveBeenCalledTimes(1))
    const assignments = confirmIpc.mock.calls[0][2] as { findingId: number; role: string }[]
    expect(assignments.find((a) => a.findingId === 9)).toBeUndefined()
  })

  it('post button opens confirm dialog naming targets; partial failure renders retry', async () => {
    status.mockResolvedValue(payloadFor(job({ confirmedAt: '2026-08-01T00:00:10Z' }), draft()))
    post.mockResolvedValue({
      comment: { ok: true, at: '2026-08-01T00:00:11Z' },
      attachment: { ok: false, error: 'upload failed', at: '2026-08-01T00:00:11Z' }
    })
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    const postBtn = await screen.findByRole('button', { name: /post to jira/i })
    await userEvent.click(postBtn)

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    const opts = vi.mocked(confirm).mock.calls[0][0]
    expect(opts.title).toMatch(/post rca to jira/i)
    expect(String(opts.message)).toMatch(/jira comment/i)
    expect(String(opts.message)).toMatch(/attachment/i)

    await waitFor(() => expect(post).toHaveBeenCalledWith('NAV-1'))
    expect(await screen.findByText('upload failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry jira attachment/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry jira comment/i })).not.toBeInTheDocument()
  })

  it('declining the post confirm dialog does not call post', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    status.mockResolvedValue(payloadFor(job({ confirmedAt: '2026-08-01T00:00:10Z' }), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    const postBtn = await screen.findByRole('button', { name: /post to jira/i })
    await userEvent.click(postBtn)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(post).not.toHaveBeenCalled()
  })

  it('updates live from an onRcaChanged broadcast without re-polling status', async () => {
    status.mockResolvedValue(payloadFor(job({ state: 'queued' })))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument())
    expect(status).toHaveBeenCalledTimes(1)

    rcaChangedCb?.(payloadFor(job({ state: 'done' }), draft()))
    expect(await screen.findByText('the cache key omitted the tenant id')).toBeInTheDocument()
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('reopening the panel after confirm shows the edited (confirmed) structure, not the raw draft', async () => {
    // Simulates the main-process fix: once confirmed, `rca.status` returns the frozen,
    // human-edited structure — a fresh mount (e.g. reopening the panel) must render that,
    // not some stale raw-model text.
    status.mockResolvedValue(
      payloadFor(
        job({ confirmedAt: '2026-08-01T00:00:10Z' }),
        draft({
          rootCause: {
            findingId: 1,
            statement: 'human-edited root cause statement',
            evidence: []
          }
        })
      )
    )
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    expect(await screen.findByText('human-edited root cause statement')).toBeInTheDocument()
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument()
  })

  it('regenerating from a done state calls generate and returns to the running state, dropping the confirmed badge', async () => {
    status.mockResolvedValue(payloadFor(job({ confirmedAt: '2026-08-01T00:00:10Z' }), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /regenerate/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(String(vi.mocked(confirm).mock.calls[0][0].message)).toMatch(/discards/i)
    await waitFor(() => expect(generate).toHaveBeenCalledWith('NAV-1'))

    // The real transition happens via the broadcast, mirroring how RcaJobs.generate behaves.
    rcaChangedCb?.(payloadFor(job({ state: 'queued', confirmedAt: null })))
    await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument())
    expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument()
  })

  it('Detach clears a claim finding link without dropping the claim; it is excluded from the confirm assignment set', async () => {
    status.mockResolvedValue(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('no tenant-scoping test existed')

    await userEvent.click(screen.getByRole('button', { name: /detach finding 2/i }))
    // the claim text stays visible — Detach only unlinks the finding, it does not remove it
    expect(screen.getByText('no tenant-scoping test existed')).toBeInTheDocument()
    expect(screen.queryByText('finding 2')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await waitFor(() => expect(confirmIpc).toHaveBeenCalledTimes(1))
    const assignments = confirmIpc.mock.calls[0][2] as { findingId: number; role: string }[]
    expect(assignments.find((a) => a.findingId === 2)).toBeUndefined()
  })

  it('confirm rejection renders the error, refetches status, and keeps the panel interactive', async () => {
    status.mockResolvedValueOnce(payloadFor(job(), draft()))
    confirmIpc.mockRejectedValueOnce(new Error('finding 2 does not belong to case NAV-1'))
    status.mockResolvedValueOnce(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    expect(await screen.findByText(/finding 2 does not belong to case nav-1/i)).toBeInTheDocument()
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    // panel stays interactive — the confirm button is not stuck disabled
    expect(screen.getByRole('button', { name: /confirm & freeze/i })).not.toBeDisabled()
  })

  it('warns explicitly (naming the missing root cause) before freezing a report with no root cause', async () => {
    status.mockResolvedValue(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')

    const rootSelect = screen.getByRole('combobox', { name: /role for finding 1/i })
    await userEvent.selectOptions(rootSelect, 'unclassified')
    expect(screen.queryByText('the cache key omitted the tenant id')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    const opts = vi.mocked(confirm).mock.calls[0][0]
    expect(String(opts.message)).toMatch(/root cause/i)
    // confirmDialog resolves true (default mock) — the freeze proceeds
    await waitFor(() => expect(confirmIpc).toHaveBeenCalledTimes(1))
  })

  it('declining the missing-root-cause warning does not confirm', async () => {
    status.mockResolvedValue(payloadFor(job(), draft()))
    vi.mocked(confirm).mockResolvedValue(false)
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')

    const rootSelect = screen.getByRole('combobox', { name: /role for finding 1/i })
    await userEvent.selectOptions(rootSelect, 'unclassified')

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirmIpc).not.toHaveBeenCalled()
  })
})
