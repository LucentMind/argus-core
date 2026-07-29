// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseResolution, CaseStatus, SessionSummary } from '../../../../shared/types'
import { DEFAULT_MODE, type ModeId } from '../../../../shared/modes'

// ConfirmHost (which confirm() talks to) is mounted at the app root (App.tsx), not inside
// CaseWorkspace — mock the store directly, same pattern as ReposSection.test.tsx and
// PrPickerDialog.test.tsx.
vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

// jsdom has no runtime ResizeObserver; DOM lib types already declare it globally.
/* eslint-disable @typescript-eslint/no-empty-function */
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
/* eslint-enable @typescript-eslint/no-empty-function */
globalThis.ResizeObserver = globalThis.ResizeObserver ?? RO

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: true },
    loadError: null
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  uiStore.setFindingsCollapsed(false)
  uiStore.setFindingsWidth(384)
  // CaseWorkspace renders Composer, which reads the shared settingsStore
  // singleton — reset it so state doesn't leak across tests.
  settingsStore.reset()
  window.argus = {
    agent: {
      history: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
      send: vi.fn(),
      interrupt: vi.fn(),
      authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })),
      preflight: vi.fn(async () => ({ ok: true, checks: [] })),
      onAuthChanged: vi.fn(() => () => {})
    },
    sessions: {
      list: vi.fn(async () => [{ id: 1, title: '', turnCount: 0, updatedAt: '' }])
    },
    modes: {
      available: vi.fn(async () => ['investigation'])
    },
    cases: {
      readFindings: vi.fn(async () => ''),
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 1 }))
    },
    distill: {
      status: vi.fn(async () => null),
      retry: vi.fn(),
      redistill: vi.fn(),
      similar: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined)
    },
    findings: {
      list: vi.fn(async () => []),
      review: vi.fn()
    },
    evidence: {
      list: vi.fn(async () => []),
      ingest: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
      onParsing: vi.fn(() => () => {})
    },
    textdoc: {
      open: vi.fn(async () => ({ ok: true, title: '', lang: null, ref: null, totalLines: 0 })),
      lines: vi.fn(async (_s, from) => ({ from, lines: [] })),
      search: vi.fn(async () => undefined),
      cancelSearch: vi.fn(async () => undefined),
      onSearchHits: vi.fn(() => () => {}),
      onIndexProgress: vi.fn(() => () => {})
    },
    files: {
      list: vi.fn(async () => []),
      read: vi.fn(),
      open: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {})
    },
    packs: {
      artifactMeta: vi.fn(async () => [
        { type: 'binlog', displayName: 'Binary log', analyzeSkill: 'analyze-binlog', isText: false }
      ])
    },
    pathForFile: vi.fn(),
    workspaces: {
      list: vi.fn(async () => []),
      refs: vi.fn(async () => []),
      pick: vi.fn(async () => null),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined)
    },
    pr: {
      list: vi.fn(async () => []),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ candidates: [], error: null, searchedRepos: [] })),
      // The review-mode left aside mounts PrCompanionSection, which loads/refreshes/subscribes
      // through these the moment the case is in review mode.
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },
    graph: {
      status: vi.fn(async () => []),
      build: vi.fn(async () => ({ started: true })),
      install: vi.fn(async () => ({ ok: true, log: '' })),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => {})
    },
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    search: { query: vi.fn(async () => []) },
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    panels: {
      list: vi.fn(async () => []),
      decls: vi.fn(async () => [
        {
          packId: 'sample-pack',
          windowId: 'text-viewer',
          title: 'Text Viewer',
          handles: ['logcat']
        }
      ]),
      open: vi.fn(async () => ({
        caseSlug: 'CASE-1',
        packId: 'sample-pack',
        windowId: 'text-viewer',
        title: 'Text Viewer',
        floated: false
      })),
      close: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
      popOut: vi.fn(async () => undefined),
      dockBack: vi.fn(async () => undefined),
      setTheme: vi.fn(async () => undefined),
      setBounds: vi.fn(async () => undefined),
      setVisible: vi.fn(async () => undefined),
      closeCase: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
      onActivate: vi.fn(() => () => undefined)
    }
  } as never
})

function workspace(
  slug: string,
  overrides?: {
    status?: CaseStatus
    resolution?: CaseResolution | null
    onStatusChanged?: () => void
    activeMode?: ModeId
    onModeSwitched?: () => void
  }
): React.JSX.Element {
  return (
    <CaseWorkspace
      slug={slug}
      jiraKey={null}
      jiraSyncedAt={null}
      status={overrides?.status ?? 'open'}
      resolution={overrides?.resolution ?? null}
      activeMode={overrides?.activeMode ?? DEFAULT_MODE}
      onStatusChanged={overrides?.onStatusChanged ?? vi.fn()}
      onModeSwitched={overrides?.onModeSwitched ?? vi.fn()}
      onOpenHit={vi.fn()}
      onOpenCitation={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenRepoFile={vi.fn()}
    />
  )
}

function renderWorkspace(overrides?: {
  status?: CaseStatus
  resolution?: CaseResolution | null
  onStatusChanged?: () => void
  activeMode?: ModeId
  onModeSwitched?: () => void
}): ReturnType<typeof render> {
  return render(workspace('NAV-1', overrides))
}

// CaseFiles is evidence-only: the Analyze button comes from evidence.list, not files.list
function stubAnalyzableFile(): void {
  window.argus.evidence.list = vi.fn(async () => [
    {
      id: 1,
      caseId: 1,
      relPath: 'evidence/trace.binlog',
      sha256: 'x',
      artifactType: 'binlog',
      size: 10,
      origin: 'upload',
      meta: {},
      createdAt: '2026-03-14T09:32:00.000Z'
    }
  ]) as never
}

describe('CaseWorkspace composer prefill', () => {
  it('clears an Analyze prefill when switching to another case', async () => {
    stubAnalyzableFile()
    const view = renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(box.value).toBe('/analyze-binlog evidence/trace.binlog')
    // switching tabs rerenders with the new slug — case A's suggestion must not leak into case B.
    // ChatPane briefly unmounts while the new case's session id loads (Task 5 bridge), so
    // await its remount rather than querying synchronously.
    view.rerender(workspace('NAV-2'))
    const boxAfter = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(boxAfter.value).toBe('')
  })

  it('Analyze works in the new case even for an identical suggestion string', async () => {
    // both cases hold an identically-named file, so both suggest the same text; the
    // stale prefill from case A must not swallow case B's click as a state no-op
    stubAnalyzableFile()
    const view = renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    view.rerender(workspace('NAV-2'))
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    const box = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(box.value).toBe('/analyze-binlog evidence/trace.binlog')
  })
})

describe('CaseWorkspace case switching', () => {
  it('remounts CaseFiles on slug change so per-case state (type filter) resets', async () => {
    const { rerender } = render(workspace('NAV-1'))
    const select = (await screen.findByLabelText('type-filter')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'binlog' } })
    expect(select.value).toBe('binlog')
    // switching tabs must not leak case A's filter/collapse/parsing state into case B
    rerender(workspace('NAV-2'))
    expect((screen.getByLabelText('type-filter') as HTMLSelectElement).value).toBe('')
  })
})

describe('CaseWorkspace session bootstrap', () => {
  it('shows an inline error when sessions.list rejects, without crashing', async () => {
    window.argus.sessions.list = vi.fn(async () => {
      throw new Error('boom')
    })
    renderWorkspace()
    expect(await screen.findByText('Could not load chat sessions.')).toBeTruthy()
  })
})

// Regression coverage for the stale-mirror bug: CaseWorkspace used to keep a
// `localActiveMode` React state seeded from the `activeMode` prop. Nothing told the parent
// (App.tsx) to refetch its `cases` array after a mode switch, so a full unmount/remount
// (e.g. going home and reopening the case) re-seeded that mirror from the now-stale prop,
// while `sessionId` — resolved from `uiStore`, persisted independently — had already moved
// on to the new mode's chat. The switcher then highlighted the old mode while the visibly
// open chat belonged to the new one. The fix deletes the mirror (the switcher renders
// directly off `activeMode`) and adds `onModeSwitched`, a same-shaped callback to
// `onStatusChanged` that App.tsx wires to the same `reload()` — that's what keeps the prop
// from going stale in the first place.
describe('CaseWorkspace mode switching', () => {
  // uiStore is a module-level singleton (not reset by beforeEach); these tests move
  // NAV-1's active session to 7, which would otherwise leak into later tests in this
  // file that assume the default single session (id 1).
  afterEach(() => {
    uiStore.setActiveSession('NAV-1', 1)
  })

  function stubTwoModeSessions(): void {
    window.argus.modes.available = vi.fn(async (): Promise<ModeId[]> => ['investigation', 'review'])
    window.argus.sessions.list = vi.fn(async (): Promise<SessionSummary[]> => [
      {
        id: 1,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'investigation'
      },
      {
        id: 7,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'review'
      }
    ])
    window.argus.cases.setMode = vi.fn(async () => ({ sessionId: 7 }))
  }

  // uiStore.activeSessions is deliberately not persisted, so after a restart the bootstrap
  // falls back to the newest chat of ANY mode while activeMode comes from the DB. That
  // mismatch strands the user: ModeSwitcher.pick early-returns when the clicked mode is
  // already the active one, so there is no way to reach the right chat. A fresh slug is
  // used so no earlier test's activeSessions entry short-circuits the fallback.
  it('bootstraps to the newest chat of the case’s own mode, not the newest chat overall', async () => {
    window.argus.modes.available = vi.fn(async (): Promise<ModeId[]> => ['investigation', 'review'])
    window.argus.sessions.list = vi.fn(async (): Promise<SessionSummary[]> => [
      {
        id: 9, // newest overall, but the wrong mode
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'investigation'
      },
      {
        id: 7,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'review'
      }
    ])

    render(workspace('NAV-BOOT', { activeMode: 'review' }))

    await waitFor(() => expect(window.argus.agent.history).toHaveBeenCalledWith('NAV-BOOT', 7))
    expect(window.argus.agent.history).not.toHaveBeenCalledWith('NAV-BOOT', 9)
  })

  // sessionsError replaces the whole chat, so a stale one from a rejected switch hides the
  // transcript indefinitely — including after the retry that succeeded.
  it('clears a previous switch error once a switch succeeds', async () => {
    stubTwoModeSessions()
    window.argus.cases.setMode = vi.fn(async () => {
      throw new Error('not available')
    })
    render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))
    expect(await screen.findByText('Could not switch mode for this chat.')).toBeTruthy()

    window.argus.cases.setMode = vi.fn(async () => ({ sessionId: 7 }))
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    await waitFor(() =>
      expect(screen.queryByText('Could not switch mode for this chat.')).toBeNull()
    )
  })

  it('says it is searching while the PR search is in flight, instead of showing nothing', async () => {
    stubTwoModeSessions()
    let resolve!: (v: unknown) => void
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      () => new Promise((r) => (resolve = r))
    )
    render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: /case mode · review/i }))
    // the indicator lives on the control the user just clicked, not adrift on the page
    const reviewBtn = screen.getByRole('button', { name: /case mode · review/i })
    await waitFor(() => expect(reviewBtn.getAttribute('aria-busy')).toBe('true'))
    expect(await screen.findByText(/searching .* pull requests/i)).toBeTruthy()

    resolve({ candidates: [], error: null, searchedRepos: ['x/y'] })
    await waitFor(() => expect(screen.queryByText(/searching .* pull requests/i)).toBeNull())
    expect(reviewBtn.getAttribute('aria-busy')).toBe('false')
  })

  it('offers the PR picker after switching to review with nothing bound yet', async () => {
    stubTwoModeSessions()
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({
        candidates: [
          {
            owner: 'JiaweiHan88',
            repo: 'HiveMindTest',
            number: 16315,
            url: 'https://github.com/JiaweiHan88/HiveMindTest/pull/16315',
            title: '[NN-5165] fix the thing',
            state: 'merged',
            isDraft: false,
            createdAt: '2026-07-21T10:00:00Z',
            isBackport: false,
            preselected: true
          }
        ],
        error: null,
        searchedRepos: ['JiaweiHan88/HiveMindTest']
      })
    )
    render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    // the search runs only after the switch resolves, so the chat is never delayed by it
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    expect(await screen.findByRole('radio', { name: /16315/ })).toBeTruthy()
  })

  it('does not offer the picker when the case already has bound PRs', async () => {
    stubTwoModeSessions()
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async () => [
      { id: 1, number: 16315 }
    ])
    render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))
    await waitFor(() => expect(window.argus.cases.setMode).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(window.argus.pr.search).not.toHaveBeenCalled()
  })

  // Re-review fix: `pr.list` is a genuine IPC round trip (unlike a microtask), so it can
  // resolve strictly AFTER the render that would have shown the picker already interactive.
  // The old handler opened the dialog immediately and filled in `currentBinding` whenever
  // `pr.list` happened to resolve — leaving a real window where "Link selected" was
  // clickable with `currentBinding` still `null`, which `PrPickerDialog.confirm()` cannot
  // tell apart from "nothing is bound". This exercises the real async ordering (the mock
  // resolves on a later tick, not synchronously) rather than passing `currentBinding` as a
  // prop like the PrPickerDialog-level tests do.
  it('never opens the picker before pr.list resolves, so the replace-confirm can never be skipped', async () => {
    let resolveList!: (bound: unknown[]) => void
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      () => new Promise((r) => (resolveList = r))
    )
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({
        candidates: [
          {
            owner: 'acme',
            repo: 'widget',
            number: 100,
            url: 'https://github.com/acme/widget/pull/100',
            title: 'the original PR',
            state: 'merged',
            isDraft: false,
            createdAt: '2026-07-20T10:00:00Z',
            isBackport: false,
            preselected: true
          },
          {
            owner: 'acme',
            repo: 'widget',
            number: 205,
            url: 'https://github.com/acme/widget/pull/205',
            title: 'a later PR',
            state: 'merged',
            isDraft: false,
            createdAt: '2026-07-25T10:00:00Z',
            isBackport: false,
            preselected: false
          }
        ],
        error: null,
        searchedRepos: ['acme/widget']
      })
    )
    render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Find PRs' }))
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    // pr.list has not resolved yet — the dialog must not be up (and so nothing is clickable)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('button', { name: /link selected/i })).toBeNull()

    // now let the (already-bound-to-#100) lookup resolve, on a later tick
    resolveList([
      {
        id: 1,
        caseId: 1,
        repoPath: null,
        owner: 'acme',
        repo: 'widget',
        number: 100,
        url: 'https://github.com/acme/widget/pull/100',
        source: 'search',
        detectedAt: '2026-07-20T10:00:00Z'
      }
    ])

    await screen.findByRole('button', { name: /link selected/i })
    fireEvent.click(screen.getByRole('radio', { name: /205/ }))
    fireEvent.click(screen.getByRole('button', { name: /link selected/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(vi.mocked(confirm).mock.calls[0][0].title as string).toContain('acme/widget#100')
  })

  const oneCandidate = [
    {
      owner: 'acme',
      repo: 'widget',
      number: 100,
      url: 'https://github.com/acme/widget/pull/100',
      title: 'the original PR',
      state: 'merged' as const,
      isDraft: false,
      createdAt: '2026-07-20T10:00:00Z',
      isBackport: false,
      preselected: true
    }
  ]

  // Re-review fix: CaseWorkspace is never remounted on a slug change (App.tsx renders it
  // with no `key`; the `slug !== lastSlug` block patches state in place), so a case switch
  // started while handlePrsFound's chain is still in flight would otherwise land case A's
  // late-resolving result on the now-current case B — B's real binding is never consulted,
  // and "Link selected" would call `pr.link(B, aCandidateFoundViaA'sRepos)`. This exercises
  // the in-flight half of the fix (the `currentSlugRef` guard inside `handlePrsFound`); the
  // next test exercises the already-resolved half (clearing an open dialog on switch).
  it('drops a Find-PRs lookup that resolves after switching to a different case', async () => {
    // ReposSection's own `reload()` effect ALSO calls `pr.list(slug)` (on mount, and again
    // when `slug` changes) — a single shared resolver would get silently reassigned to
    // whichever of those calls happens to be pending, defeating the point of this test.
    // Track every call instead, so the ONE this test cares about (handlePrsFound's, for
    // case A) can be resolved on its own, independent of ReposSection's mount-time call and
    // its own reload for case B triggered by the switch below.
    const listResolvers: Array<(bound: unknown[]) => void> = []
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      () => new Promise((r) => listResolvers.push(r))
    )
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({ candidates: oneCandidate, error: null, searchedRepos: ['acme/widget'] })
    )
    const view = render(workspace('NAV-1', { activeMode: 'investigation' }))
    await screen.findByRole('button', { name: 'Find PRs' })
    // resolve ReposSection's own mount-time pr.list('NAV-1') call — irrelevant to this test
    listResolvers.shift()?.([])

    fireEvent.click(screen.getByRole('button', { name: 'Find PRs' }))
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    // handlePrsFound's own pr.list('NAV-1') call, now pending — capture ITS resolver before
    // switching, so the switch's own pr.list('NAV-2') call can't be confused with it
    await waitFor(() => expect(listResolvers.length).toBe(1))
    const resolveCaseA = listResolvers[0]

    // switch case BEFORE case A's in-flight lookup resolves
    view.rerender(workspace('NAV-2', { activeMode: 'investigation' }))

    resolveCaseA([]) // case A's lookup resolves late, after the switch
    await new Promise((r) => setTimeout(r, 0))
    // A's dialog must not have opened on top of B, and nothing was linked on B's behalf
    expect(screen.queryByRole('button', { name: /link selected/i })).toBeNull()
    expect(window.argus.pr.link).not.toHaveBeenCalled()
  })

  it('closes an already-open Find-PRs dialog when the case is switched', async () => {
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({ candidates: oneCandidate, error: null, searchedRepos: ['acme/widget'] })
    )
    const view = render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Find PRs' }))
    await screen.findByRole('button', { name: /link selected/i }) // dialog is up for A

    view.rerender(workspace('NAV-2', { activeMode: 'investigation' }))
    expect(screen.queryByRole('button', { name: /link selected/i })).toBeNull()
    expect(window.argus.pr.link).not.toHaveBeenCalled()
  })

  // Re-review fix: `handlePrsFound` (the "Find PRs" button) got the case-switch guard above,
  // but `handleModeChanged`'s auto-search — entering review mode with nothing bound — is a
  // SECOND path that opens the same dialog and had the same defect, worse: it never called
  // `setPrPickerCurrent` at all, so it always rendered the dialog with `currentBinding: null`
  // even with no case switch involved — masked only because `bound.length` had already been
  // checked to be zero for the same slug moments earlier. Both paths now funnel through the
  // shared, guarded `openPrPicker`. Driven through the ModeSwitcher's Review button rather
  // than "Find PRs", mirroring the two tests above.
  it('drops a review-mode auto-search result that resolves after switching to a different case', async () => {
    stubTwoModeSessions()
    let resolveSearch!: (r: unknown) => void
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      () => new Promise((r) => (resolveSearch = r))
    )
    // default pr.list already resolves [] for any slug — matches "nothing bound yet" for A
    const view = render(workspace('NAV-1', { activeMode: 'investigation' }))

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))

    // switch case BEFORE case A's in-flight pr.search resolves — case B (per the scenario
    // this pins) has a REAL pull request bound; that's not asserted directly here (no chip
    // rendering is under test), but it's why a no-confirmation link would be so much worse
    // on this path than on the "Find PRs" one, which at least always looked currentBinding
    // up first.
    view.rerender(workspace('NAV-2', { activeMode: 'investigation' }))

    resolveSearch({ candidates: oneCandidate, error: null, searchedRepos: ['acme/widget'] })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('button', { name: /link selected/i })).toBeNull()
    expect(window.argus.pr.link).not.toHaveBeenCalled()
  })

  // Re-review fix: `handlePrsFound` used to be `void`-ed, so ReposSection's
  // `.then(onPrsFound).finally(() => setSearching(false))` did not actually wait for it —
  // `onPrsFound` returned synchronously (`void`), so `finally` ran as soon as `pr.search`
  // itself resolved, re-enabling "Find PRs" while the picker's own `pr.list` lookup (and so
  // the dialog opening) was still pending. `handlePrsFound` now returns its promise, so
  // `.then` genuinely chains onto it.
  it('keeps Find PRs disabled until the picker is actually up, not just until pr.search resolves', async () => {
    let resolveList!: (bound: unknown[]) => void
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      () => new Promise((r) => (resolveList = r))
    )
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({ candidates: oneCandidate, error: null, searchedRepos: ['acme/widget'] })
    )
    render(workspace('NAV-1', { activeMode: 'investigation' }))
    const findBtn = await screen.findByRole('button', { name: 'Find PRs' })

    fireEvent.click(findBtn)
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    // pr.search has resolved, but the chain's own pr.list lookup hasn't — the control must
    // still read busy, not just while pr.search itself was in flight
    await waitFor(() => expect(findBtn).toBeDisabled())

    resolveList([])
    await waitFor(() => expect(findBtn).not.toBeDisabled())
  })

  it('calls onModeSwitched after a switch (the callback contract that keeps the parent’s case list — and so the activeMode prop — from going stale), and renders no optimistic mirror of its own', async () => {
    stubTwoModeSessions()
    const onModeSwitched = vi.fn()
    render(workspace('NAV-1', { activeMode: 'investigation', onModeSwitched }))

    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    fireEvent.click(reviewBtn)

    await waitFor(() => expect(window.argus.cases.setMode).toHaveBeenCalledWith('NAV-1', 'review'))
    // this is what actually closes the bug: it's App.tsx's signal to reload() its case
    // list, so the next time this prop is supplied it carries the real, persisted mode
    await waitFor(() => expect(onModeSwitched).toHaveBeenCalled())
    // the mode's chat (session 7, per cases.setMode's result) is now the active session
    expect(uiStore.get().activeSessions['NAV-1']).toBe(7)

    // Before the parent has actually re-supplied a fresh `activeMode`, the switcher must
    // not fake an optimistic flip — with the mirror removed, it can only show what the
    // prop says. (This is the divergence the bug produced: the old mirror flipped
    // immediately and then re-seeded wrongly from a stale prop on remount.)
    expect(
      screen.getByRole('button', { name: /investigation/i }).getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('reflects a round trip correctly once the parent responds to onModeSwitched: after a switch, an unmount, and a remount with the refreshed activeMode, the switcher matches the still-open session', async () => {
    stubTwoModeSessions()
    const { unmount } = render(workspace('NAV-1', { activeMode: 'investigation' }))

    // The mode switcher's Review control carries its own aria-label ("Case mode · Review");
    // matched by that exact string rather than /review/i because once the mode is review,
    // ReviewRunButton (rendered beside it) has an accessible name of "Run review" — a loose
    // /review/i would still match both.
    const reviewBtn = await screen.findByRole('button', { name: 'Case mode · Review' })
    fireEvent.click(reviewBtn)
    await waitFor(() => expect(uiStore.get().activeSessions['NAV-1']).toBe(7))

    // simulate navigating home (CaseWorkspace fully unmounts — one branch of App.tsx's
    // view.kind ternary) and back. onModeSwitched fired above, so by the time the case is
    // reopened App.tsx's cases array — and thus this prop — carries the persisted mode.
    unmount()
    render(workspace('NAV-1', { activeMode: 'review' }))

    const reviewAfter = await screen.findByRole('button', { name: 'Case mode · Review' })
    expect(reviewAfter.getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('button', { name: /investigation/i }).getAttribute('aria-pressed')
    ).toBe('false')
    // the session the switcher now agrees with is the one that's actually open
    expect(uiStore.get().activeSessions['NAV-1']).toBe(7)
  })
})

describe('CaseWorkspace findings pane', () => {
  it('drag on the separator resizes the pane (leftwards widens)', () => {
    const { container } = renderWorkspace()
    // jsdom never lays out the page, so <main> reports clientWidth 0; the drag handle
    // clamps against it (Task 5 pane-overlap guard). Stub a roomy viewport so this test
    // still exercises plain resize math — the clamp itself is covered separately below.
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 900 })
    expect(uiStore.get().findingsWidth).toBe(484)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    // after release, further moves change nothing
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500 })
    expect(uiStore.get().findingsWidth).toBe(484)
  })

  it('drag cannot widen the findings pane past what leaves chat its minimum width', () => {
    const { container } = renderWorkspace()
    // Narrow main column (500px): chat can give up at most 500 - CHAT_MIN_WIDTH (360) = 140px,
    // so findings should clamp at 384 + 140 = 524 even though the pointer travels further.
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 500
    })
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700 })
    expect(uiStore.get().findingsWidth).toBe(524)
    fireEvent.pointerUp(sep, { pointerId: 1 })
  })

  it('collapse hides the pane and the edge button expands it back', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse findings' }))
    expect(screen.queryByRole('separator', { name: 'Resize findings pane' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(false)
    expect(screen.getByRole('separator', { name: 'Resize findings pane' })).toBeTruthy()
  })
})

describe('CaseWorkspace evidence pane', () => {
  it('collapse hides the pane and the edge button expands it back', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse evidence' }))
    expect(screen.queryByRole('button', { name: 'Collapse evidence' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand evidence' }))
    expect(uiStore.get().evidenceCollapsed).toBe(false)
    expect(screen.getByRole('button', { name: 'Collapse evidence' })).toBeTruthy()
  })
})

describe('CaseWorkspace panel tab host', () => {
  it('shows a Chat tab and lists available panels in the launcher', async () => {
    renderWorkspace()
    expect(await screen.findByText('Chat')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('New panel'))
    expect(await screen.findByText('Text Viewer')).toBeTruthy()
  })
})

describe('CaseWorkspace case-id menu', () => {
  it('closes the case as duplicate via the Close as… submenu', async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined)
    window.argus.cases.setStatus = setStatus
    const onStatusChanged = vi.fn()
    renderWorkspace({ status: 'open', resolution: null, onStatusChanged })
    // case id opens the menu; "Close as…" expands its submenu; then pick a resolution
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /close as/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'duplicate' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('NAV-1', 'closed', 'duplicate'))
    expect(onStatusChanged).toHaveBeenCalled()
  })

  it('shows Reopen and the resolution label when the case is closed', async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined)
    window.argus.cases.setStatus = setStatus
    const onStatusChanged = vi.fn()
    renderWorkspace({ status: 'closed', resolution: 'wont-fix', onStatusChanged })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    // the closed status still reads on the submenu parent
    fireEvent.click(screen.getByRole('menuitem', { name: /closed · wont-fix/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('NAV-1', 'open', null))
    expect(onStatusChanged).toHaveBeenCalled()
  })

  it('shows a bare "Closed" label (not "Close as…") for a legacy closed case with no resolution', async () => {
    renderWorkspace({ status: 'closed', resolution: null })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Closed' }))
    expect(screen.getByRole('menuitem', { name: 'Reopen' })).toBeTruthy()
  })

  it('exports the case via the Export submenu', async () => {
    const exportFn = vi.fn().mockResolvedValue({ ok: true, fileCount: 3 })
    window.argus.bundle = { export: exportFn } as never
    renderWorkspace({ status: 'open', resolution: null })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export case…' }))
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith('NAV-1', true))
    expect(await screen.findByText(/exported 3 files/i)).toBeTruthy()
  })
})

describe('evidence section per mode', () => {
  it('review mode: relabeled to Code review artifacts, no search, no similar cases', async () => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    expect(await screen.findByText('Code review artifacts')).toBeInTheDocument()
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/search evidence/i)).not.toBeInTheDocument()
  })

  it('investigation mode: Evidence label and search stay', async () => {
    render(workspace('NAV-1', { activeMode: 'investigation' }))
    expect(await screen.findByText('Evidence')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/search evidence/i)).toBeInTheDocument()
  })
})
