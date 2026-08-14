// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RcaPanel } from '../RcaPanel'
import {
  applyClaims,
  buildAssignments,
  draftToClaims,
  NO_ROOT_CAUSE_STATEMENT,
  reassign
} from '../../lib/rcaDraft'
import { confirm } from '../../lib/confirmStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type {
  RcaDraft,
  RcaDroppedSections,
  RcaJobRow,
  RcaStatusPayload
} from '../../../../shared/rca'
import { DEFAULT_RCA_TEMPLATE, type RcaTemplate } from '../../../../shared/rcaTemplate'
// The REAL validator (not a mock) — this is exactly the seam the fix-7/fix-4 interaction bug
// hid in: RcaPanel's own confirm mock always resolved, so nothing here previously exercised
// what the main-process IPC boundary would actually do with the draft the panel builds.
import { validateRcaDraft } from '../../../../main/services/rca/parse'

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
    sections: {},
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
  return { caseSlug: 'NAV-1', job: j, draft: d, template: DEFAULT_RCA_TEMPLATE, dropped: {} }
}

const generate = vi.fn()
const status = vi.fn()
const confirmIpc = vi.fn()
const post = vi.fn()
const renderPreview = vi.fn()
const findingsList = vi.fn()
const readMarkdown = vi.fn()
const saveMarkdown = vi.fn()
const handEdited = vi.fn()
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
  readMarkdown.mockReset().mockResolvedValue({ exec: '# exec', tech: '# tech' })
  saveMarkdown.mockReset().mockResolvedValue(undefined)
  handEdited.mockReset().mockResolvedValue({ exec: false, tech: false })
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
      }),
      readMarkdown,
      saveMarkdown,
      handEdited
    },
    findings: { list: findingsList },
    settings: { get: vi.fn(async () => settingsPayload()), onChanged: vi.fn(() => () => {}) }
  } as never
  settingsStore.reset()
})

// Alias used by the drop-toggle tests below — same mock as `confirmIpc`, just the name the
// brief's test snippets use.
const confirmFn = confirmIpc

// Alias used by the editor/discard-warning tests below — same mock as `confirm` from
// confirmStore (already mocked above), just the name the brief's test snippets use.
const confirmDialog = vi.mocked(confirm)

/** Builds a `done`-state RcaStatusPayload for slug `case-a`, job id defaulting to 1 — the
 *  fixture the drop-toggle tests below share. */
function doneStatusPayload(
  over: {
    jobId?: number
    template?: RcaTemplate
    dropped?: RcaDroppedSections
    confirmedAt?: string | null
  } = {}
): RcaStatusPayload {
  return {
    caseSlug: 'case-a',
    job: job({ id: over.jobId ?? 1, confirmedAt: over.confirmedAt ?? null }),
    draft: draft(),
    template: over.template ?? DEFAULT_RCA_TEMPLATE,
    dropped: over.dropped ?? {}
  }
}

async function renderDonePanel(
  over: {
    template?: RcaTemplate
    dropped?: RcaDroppedSections
    confirmedAt?: string | null
  } = {}
): Promise<void> {
  status.mockResolvedValue(doneStatusPayload(over))
  render(<RcaPanel slug="case-a" onClose={vi.fn()} />)
  await screen.findByText('the cache key omitted the tenant id')
}

/** Simulates an `onRcaChanged` broadcast for a new job (e.g. a regenerate) landing while the
 *  panel is open. */
async function emitPayload(
  over: { jobId?: number; template?: RcaTemplate; dropped?: RcaDroppedSections } = {}
): Promise<void> {
  rcaChangedCb?.(doneStatusPayload(over))
}

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

describe('applyClaims (pure)', () => {
  it('demoting the root-cause claim to unclassified emits the explicit placeholder statement, not empty', () => {
    const d = draft()
    const claims = reassign(draftToClaims(d), 'root', 'unclassified')
    const edited = applyClaims(d, claims)
    expect(edited.rootCause).toEqual({
      findingId: null,
      statement: NO_ROOT_CAUSE_STATEMENT,
      evidence: []
    })
    // the whole point of the placeholder: draftSchema's `.min(1)` on rootCause.statement must
    // still accept the edited draft.
    expect(() => validateRcaDraft(edited)).not.toThrow()
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
      expect.objectContaining({ rootCause: expect.anything() }),
      { exec: [], tech: [] }
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

  it('shows the error inline when Regenerate fails from the done state', async () => {
    // generateError used to only render in the `!job || failed` branch — a rejected
    // rca.generate() while the panel is showing a `done` job (no state transition, since the
    // rejection means no job was ever enqueued) left the failure invisible.
    status.mockResolvedValue(payloadFor(job(), draft()))
    generate.mockReset().mockRejectedValue(new Error('model quota exceeded'))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')

    await userEvent.click(screen.getByRole('button', { name: /regenerate/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('model quota exceeded')).toBeInTheDocument()
    // still in the done branch, still interactive
    expect(screen.getByRole('button', { name: /confirm & freeze/i })).toBeInTheDocument()
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

  it('a demoted root cause builds a draft the REAL validateRcaDraft accepts before freezing', async () => {
    // Regression for the fix-7 x fix-4 seam: applyClaims used to emit `rootCause.statement: ''`
    // when no claim held the root-cause role, which draftSchema's `.min(1)` rejects — so the
    // warning dialog's "Continue" always failed downstream with a raw zod error. This must run
    // the real validator, not a mock, or it can't catch that regression again.
    status.mockResolvedValue(payloadFor(job(), draft()))
    render(<RcaPanel slug="NAV-1" onClose={vi.fn()} />)
    await screen.findByText('the cache key omitted the tenant id')

    const rootSelect = screen.getByRole('combobox', { name: /role for finding 1/i })
    await userEvent.selectOptions(rootSelect, 'unclassified')

    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1)) // the missing-root-cause warning
    await waitFor(() => expect(confirmIpc).toHaveBeenCalledTimes(1))

    const editedDraft = confirmIpc.mock.calls[0][3] as RcaDraft
    expect(() => validateRcaDraft(editedDraft)).not.toThrow()
    expect(editedDraft.rootCause.statement).toBe('No confirmed root cause.')
    expect(editedDraft.rootCause.findingId).toBeNull()
  })

  it("lists the snapshot template's sections as drop toggles, per report", async () => {
    await renderDonePanel()
    expect(screen.getByLabelText('Include What happened in the executive summary')).toBeTruthy()
    expect(screen.getByLabelText('Include Root cause in the technical report')).toBeTruthy()
  })

  it('omits a disabled section from the toggles — it is a template decision, not a per-draft one', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].enabled = false
    await renderDonePanel({ template: t })
    expect(screen.queryByLabelText('Include What happened in the executive summary')).toBeNull()
  })

  it('re-renders the preview with the dropped id when a section is switched off', async () => {
    await renderDonePanel()
    await userEvent.click(screen.getByLabelText('Include Impact in the executive summary'))
    await vi.waitFor(() =>
      expect(renderPreview).toHaveBeenLastCalledWith('case-a', expect.anything(), {
        exec: ['exec-impact'],
        tech: []
      })
    )
  })

  it('keeps the two reports independent', async () => {
    await renderDonePanel()
    await userEvent.click(screen.getByLabelText('Include Impact in the technical report'))
    await vi.waitFor(() =>
      expect(renderPreview).toHaveBeenLastCalledWith('case-a', expect.anything(), {
        exec: [],
        tech: ['tech-impact']
      })
    )
  })

  it('passes the drop set to confirm', async () => {
    await renderDonePanel()
    await userEvent.click(screen.getByLabelText('Include Impact in the executive summary'))
    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await vi.waitFor(() =>
      expect(confirmFn).toHaveBeenCalledWith('case-a', 1, expect.anything(), expect.anything(), {
        exec: ['exec-impact'],
        tech: []
      })
    )
  })

  it('re-seeds the drop set from the payload when a new job lands', async () => {
    await renderDonePanel()
    await userEvent.click(screen.getByLabelText('Include Impact in the executive summary'))
    await emitPayload({ jobId: 2, dropped: {} }) // a regenerate
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Include Impact in the executive summary')).toHaveProperty(
        'checked',
        true
      )
    )
  })

  it('offers no editor until the report is confirmed', async () => {
    await renderDonePanel({ confirmedAt: null })
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
  })

  it('opens the editor on the confirmed markdown for the active tab', async () => {
    readMarkdown.mockResolvedValue({ exec: '# exec on disk', tech: '# tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    expect(screen.getByRole('textbox', { name: /executive summary markdown/i })).toHaveProperty(
      'value',
      '# exec on disk'
    )
  })

  it('saves the edited body for the active report only', async () => {
    readMarkdown.mockResolvedValue({ exec: '# exec on disk', tech: '# tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const box = screen.getByRole('textbox', { name: /executive summary markdown/i })
    await userEvent.clear(box)
    await userEvent.type(box, '# edited')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(saveMarkdown).toHaveBeenCalledWith('case-a', 'exec', '# edited'))
  })

  it('discards editor changes on cancel without saving', async () => {
    readMarkdown.mockResolvedValue({ exec: '# exec on disk', tech: '# tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /executive summary markdown/i }), 'x')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(saveMarkdown).not.toHaveBeenCalled()
  })

  it('a rejected handEdited() cannot become an unhandled rejection; the panel still renders normally', async () => {
    // handEdited.ts's readReportMarkdown call can throw a non-ENOENT error (EACCES/EBUSY on
    // Windows, an editor has the file open) which used to escape all the way out to this
    // `.then()` with no `.catch` — an unhandled rejection and a badge silently stuck.
    handEdited.mockReset().mockRejectedValue(new Error('EBUSY: resource busy or locked'))

    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
      await waitFor(() => expect(handEdited).toHaveBeenCalled())
      // Flush the microtask queue so a rejection left unhandled has a chance to be reported.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledReasons).toEqual([])
      // still renders normally, no badge stuck on
      expect(screen.queryByText(/edited/i)).not.toBeInTheDocument()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('shows an edited badge for a hand-edited report', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await vi.waitFor(() => expect(screen.getByText(/edited/i)).toBeTruthy())
  })

  it('warns before Confirm & freeze overwrites a hand-edited report, and aborts on cancel', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    confirmDialog.mockResolvedValue(false)
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await vi.waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/text edits/i) })
      )
    )
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('proceeds with Confirm & freeze when the warning is accepted', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    confirmDialog.mockResolvedValue(true)
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await vi.waitFor(() => expect(confirmFn).toHaveBeenCalled())
  })

  it('does not warn about text edits when neither report was hand-edited', async () => {
    handEdited.mockResolvedValue({ exec: false, tech: false })
    confirmDialog.mockResolvedValue(true)
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /confirm & freeze/i }))
    await vi.waitFor(() => expect(confirmFn).toHaveBeenCalled())
    for (const call of confirmDialog.mock.calls) {
      expect(call[0].message).not.toMatch(/text edits/i)
    }
  })

  it('warns before Regenerate discards a hand-edited report', async () => {
    handEdited.mockResolvedValue({ exec: false, tech: true })
    confirmDialog.mockResolvedValue(false)
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /regenerate/i }))
    await vi.waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/text edits/i) })
      )
    )
    expect(generate).not.toHaveBeenCalled()
  })

  it('re-checks hand-edited state after a save, so the badge is not stale', async () => {
    readMarkdown.mockResolvedValue({ exec: '# a', tech: '# b' })
    handEdited.mockResolvedValue({ exec: false, tech: false })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    handEdited.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(handEdited).toHaveBeenCalled())
  })

  it('surfaces a failed post-save hand-edited re-check even though the editor already closed', async () => {
    // saveMarkdown succeeds (so `editing` flips to false) but the follow-up handEdited() re-fetch
    // rejects — the error used to be set into state and rendered nowhere, since saveError only
    // rendered inside the now-closed `editing` branch.
    readMarkdown.mockResolvedValue({ exec: '# exec on disk', tech: '# tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    handEdited.mockRejectedValueOnce(new Error('disk read failed'))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('disk read failed')).toBeInTheDocument()
    // the save itself still succeeded — the editor is closed, not stuck open
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument()
  })

  it('surfaces a failed report read when opening the editor, with no unhandled rejection', async () => {
    readMarkdown.mockRejectedValueOnce(new Error('report read failed'))
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    expect(await screen.findByText('report read failed')).toBeInTheDocument()
    // the editor never opened
    expect(
      screen.queryByRole('textbox', { name: /executive summary markdown/i })
    ).not.toBeInTheDocument()
  })

  it('resets editor state (editing/body/saveError) when a new job payload lands, so a stale editor cannot survive onto a different draft', async () => {
    readMarkdown.mockResolvedValue({ exec: '# job 1 exec on disk', tech: '# job 1 tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    expect(screen.getByRole('textbox', { name: /executive summary markdown/i })).toBeInTheDocument()

    // Job 2 (e.g. a regenerate) lands via the broadcast — the previews block would have
    // unmounted while job 2 was queued/running and remounts here on the new `done` payload.
    // (doneStatusPayload defaults confirmedAt to null, matching job 2's real not-yet-confirmed
    // state, which is exactly why the Edit button being hidden alone wasn't enough protection.)
    await emitPayload({ jobId: 2 })

    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: /executive summary markdown/i })
      ).not.toBeInTheDocument()
    )
    // the preview is showing again, not a stale editor
    expect(await screen.findByText('exec preview')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument()
  })

  it('a confirmed, hand-edited exec report displays the on-disk exec markdown, not the rendered preview', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    readMarkdown.mockResolvedValue({ exec: '# exec on disk text', tech: '# tech on disk text' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    expect(await screen.findByText('exec on disk text')).toBeInTheDocument()
    expect(screen.queryByText('exec preview')).not.toBeInTheDocument()
  })

  it('regression guard: a confirmed report that is NOT hand-edited never triggers the on-disk read at all', async () => {
    // This does NOT prove the hand-edited branch reads/shows disk text correctly — the other
    // tests above cover that. It only proves the disk-read effect stays a no-op (and the pane
    // keeps rendering the preview) when nothing is hand-edited, which is exactly the check that
    // would have caught a version of the effect that read from disk unconditionally.
    handEdited.mockResolvedValue({ exec: false, tech: false })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    expect(await screen.findByText('exec preview')).toBeInTheDocument()
    expect(readMarkdown).not.toHaveBeenCalled()
  })

  it('the two tabs are independent: exec hand-edited and tech not means exec shows disk and tech shows the render', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    readMarkdown.mockResolvedValue({ exec: '# exec on disk text', tech: '# tech on disk text' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    expect(await screen.findByText('exec on disk text')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^technical report$/i }))
    expect(await screen.findByText('tech preview')).toBeInTheDocument()
    expect(screen.queryByText('tech on disk text')).not.toBeInTheDocument()
  })

  it('after a save, the pane shows the newly saved text', async () => {
    handEdited.mockReset().mockResolvedValueOnce({ exec: false, tech: false })
    readMarkdown
      .mockReset()
      .mockResolvedValueOnce({ exec: '# exec on disk', tech: '# tech on disk' })
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    expect(await screen.findByText('exec preview')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const box = screen.getByRole('textbox', { name: /executive summary markdown/i })
    await userEvent.clear(box)
    await userEvent.type(box, '# freshly saved exec text')

    handEdited.mockResolvedValueOnce({ exec: true, tech: false })
    readMarkdown.mockResolvedValueOnce({
      exec: '# freshly saved exec text',
      tech: '# tech on disk'
    })
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('freshly saved exec text')).toBeInTheDocument()
  })

  it('a rejected readMarkdown falls back to the rendered preview and shows the error, with no unhandled rejection', async () => {
    handEdited.mockResolvedValue({ exec: true, tech: false })
    readMarkdown.mockReset().mockRejectedValue(new Error('disk read failed'))

    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
      expect(await screen.findByText('exec preview')).toBeInTheDocument()
      expect(await screen.findByText('disk read failed')).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledReasons).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('switching tabs away and back does not hide that the exec pane is showing the rendered preview because the on-disk text could not be read', async () => {
    // Regression for the fix-8 finding: the tab-switch handler unconditionally clears
    // `saveError`, which used to be the ONLY signal that a hand-edited report's on-disk read had
    // failed. An ordinary "click Technical report, click back to Exec summary" used to wipe that
    // signal while `diskMarkdown` stayed null and the `edited` chip stayed lit — the user would
    // read the rendered preview believing it was the text that posts, with no warning at all.
    handEdited.mockResolvedValue({ exec: true, tech: false })
    readMarkdown.mockReset().mockRejectedValue(new Error('disk read failed'))
    await renderDonePanel({ confirmedAt: '2026-08-14T00:00:00Z' })
    expect(await screen.findByText('exec preview')).toBeInTheDocument()
    expect(await screen.findByText('disk read failed')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^technical report$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^exec summary$/i }))

    // saveError itself IS expected to be cleared by the tab-switch handler (unchanged, correct
    // behaviour for the editor's own errors) ...
    expect(screen.queryByText('disk read failed')).not.toBeInTheDocument()
    // ... but a durable signal tied to the actual state (hand-edited with no disk text) must
    // still tell the user the exec pane is not what will post, and the `edited` chip must not be
    // left implying the opposite.
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.getByText('edited')).toBeInTheDocument() // the chip, exact match
    expect(screen.getByText('exec preview')).toBeInTheDocument()
  })
})
