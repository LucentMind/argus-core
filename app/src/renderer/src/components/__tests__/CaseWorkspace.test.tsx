// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { caseBarStore } from '../../lib/caseBarStore'
import { noticeStore } from '../../lib/noticeStore'
import { sessionsStore } from '../../lib/sessionsStore'
import { clearCatalogStore } from '../../lib/catalogStore'
import { defaultSettings, settingsSchema, type SettingsPayload } from '../../../../shared/settings'
import type { SessionSummary } from '../../../../shared/types'
import { DEFAULT_MODE, type ModeId } from '../../../../shared/modes'
import type { FindingRow } from '../../../../shared/observability'

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
  uiStore.setEvidenceCollapsed(false)
  uiStore.setEvidenceWidth(320)
  uiStore.setDynamicTheme(false)
  // uiStore is a module-level singleton that only reads localStorage in its constructor —
  // localStorage.clear() above does not reset railCollapsed, so a collapse in one test would
  // otherwise leak into every later test in this file. All four rail sections render here
  // (Ticket/Repos/Pull request/Related history), not just Repos, so all four ids are reset.
  uiStore.setRailSectionCollapsed('jira', false)
  uiStore.setRailSectionCollapsed('repos', false)
  uiStore.setRailSectionCollapsed('pr', false)
  uiStore.setRailSectionCollapsed('related', false)
  caseBarStore.reset()
  // module-level singleton — a case slug reused across tests would otherwise see the previous
  // test's rows synchronously, before this test's sessions.list mock has resolved
  sessionsStore.clearForTests()
  clearCatalogStore()
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
      list: vi.fn(async () => [{ id: 1, title: '', turnCount: 0, updatedAt: '' }]),
      create: vi.fn(async () => ({ id: 3, title: '', turnCount: 0, updatedAt: '' })),
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      setModel: vi.fn(async () => ({ changed: true, permissionMode: null })),
      setRunOptions: vi.fn(async () => true),
      setPermissionMode: vi.fn(async () => true)
    },
    modes: {
      available: vi.fn(async () => ['investigation'])
    },
    // Composer fetches the pinned instance's catalog the moment a session names one — which
    // only happens here once a test actually picks a model.
    models: {
      catalog: vi.fn(async () => [])
    },
    // Composer also fetches per-instance refusal state on mount (Task 6). Empty by default —
    // nothing refused — so this file's tests never have to think about it.
    providers: {
      statuses: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {})
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
      onChanged: vi.fn(() => () => undefined)
    },
    // Left over from the pre-merge related-cases card (retired Task 7 of the
    // related-history plan); still reachable via search_known_defects and the settings page,
    // so kept as forward-compatible ground truth for increment 2.
    defects: {
      search: vi.fn(async () => []),
      test: vi.fn(async () => ({ ok: false, error: 'not configured' })),
      syncNow: vi.fn(async () => ({ ok: false })),
      syncStatus: vi.fn(async () => null)
    },
    related: {
      search: vi.fn(async () => ({ query: '', hits: [], sources: [] })),
      defect: vi.fn()
    },
    findings: {
      list: vi.fn(async () => []),
      review: vi.fn()
    },
    review: {
      worktreeHead: vi.fn(async () => null)
    },
    rca: {
      onRcaChanged: vi.fn(() => () => {})
    },
    evidence: {
      list: vi.fn(async () => []),
      ingest: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
      onQueueProgress: vi.fn(() => () => {}),
      scan: vi.fn(async () => ({ added: [], modified: [], missing: [], errors: [] }))
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
      recent: vi.fn(async () => []),
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
    activeMode?: ModeId
    onModeSwitched?: () => void
    archivedAt?: string | null
  }
): React.JSX.Element {
  return (
    <CaseWorkspace
      slug={slug}
      archivedAt={overrides?.archivedAt ?? null}
      activeMode={overrides?.activeMode ?? DEFAULT_MODE}
      caseTitle="a case"
      jiraKey={null}
      jiraSyncedAt={null}
      onModeSwitched={overrides?.onModeSwitched ?? vi.fn()}
      onOpenHit={vi.fn()}
      onOpenCitation={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenRepoFile={vi.fn()}
    />
  )
}

function renderWorkspace(overrides?: {
  activeMode?: ModeId
  onModeSwitched?: () => void
  archivedAt?: string | null
}): ReturnType<typeof render> {
  return render(workspace('NAV-1', overrides))
}

function findingRow(over: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 's',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: '2026-07-27T10:00:00.000Z',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    commentBody: null,
    headSha: null,
    mode: 'investigation',
    role: null,
    ...over
  }
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

describe('CaseWorkspace bar merge', () => {
  it('no longer renders a case header of its own', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    // The bar owns the case identity now; a second <header> here is the duplication the
    // merge removes.
    expect(screen.queryByRole('banner')).toBeNull()
  })

  it('acts on a mode switch published by the bar', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    window.argus.sessions.list = vi.fn(async () => [])
    caseBarStore.emit({
      kind: 'mode-switched',
      slug: 'NAV-1',
      mode: 'investigation',
      sessionId: 42
    })
    await vi.waitFor(() => expect(window.argus.sessions.list).toHaveBeenCalled())
  })

  it('ignores a mode switch published for another case', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    window.argus.sessions.list = vi.fn(async () => [])
    caseBarStore.emit({ kind: 'mode-switched', slug: 'OTHER-9', mode: 'review', sessionId: 42 })
    await new Promise((r) => setTimeout(r, 0))
    expect(window.argus.sessions.list).not.toHaveBeenCalled()
  })

  // "publishes review PR-search busy state for the bar to render" and "clears the bar store on
  // unmount" lived here. Both pinned `caseBarStore`'s state channel, which no longer exists —
  // the PR search reports in the Pull request rail now (see 'says it is searching…' below), so
  // there is no cross-subtree publish to make, and therefore nothing that can outlive an
  // unmount and need clearing. The event channel this describe block otherwise covers is
  // unchanged.
})

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
  it('remounts CaseFiles on slug change so per-case state (rescan result) resets', async () => {
    const { rerender } = render(workspace('NAV-1'))
    const rescanBtn = await screen.findByRole('button', { name: 'Rescan evidence folder' })
    fireEvent.click(rescanBtn)
    await waitFor(() =>
      expect(rescanBtn).toHaveAttribute('title', expect.stringContaining('no changes'))
    )
    // switching tabs must not leak case A's scan-result/collapse/parsing state into case B
    rerender(workspace('NAV-2'))
    expect(await screen.findByRole('button', { name: 'Rescan evidence folder' })).toHaveAttribute(
      'title',
      'Rescan evidence folder'
    )
  })

  it('remounts CaseFiles on mode change so per-case state (rescan result) resets', async () => {
    const { rerender } = render(workspace('NAV-1', { activeMode: 'investigation' }))
    const rescanBtn = await screen.findByRole('button', { name: 'Rescan evidence folder' })
    fireEvent.click(rescanBtn)
    await waitFor(() =>
      expect(rescanBtn).toHaveAttribute('title', expect.stringContaining('no changes'))
    )
    // investigation evidence and review artifacts are disjoint lists — a mode switch must
    // not leak investigation's scan-result/collapse/parsing state into review's list
    rerender(workspace('NAV-1', { activeMode: 'review' }))
    expect(await screen.findByRole('button', { name: 'Rescan evidence folder' })).toHaveAttribute(
      'title',
      'Rescan evidence folder'
    )
  })

  // Regression coverage: FindingsPane's rejection handler deliberately stopped clearing
  // `findings` on a failed fetch (a transient failure must not wipe findings already on
  // screen and claim the case has none). That fix only works because FindingsPane is keyed
  // on `slug` — the remount resets its state on every case switch. Without the key, the
  // exact same component instance carries case A's findings across the switch, and since
  // rejection no longer clears them, case B renders under case A's stale findings if its
  // own fetch fails — worse than the empty-state bug the other fix removed.
  it('does not leak case A findings into case B when case B’s findings.list rejects', async () => {
    window.argus.findings.list = vi.fn(async (slug: string) => {
      if (slug === 'NAV-1') return [findingRow({ id: 1, summary: 'Root cause A' })]
      throw new Error('boom')
    }) as never
    const { rerender } = render(workspace('NAV-1'))
    await screen.findByText('Root cause A')

    rerender(workspace('NAV-2'))

    await waitFor(() => expect(window.argus.findings.list).toHaveBeenCalledWith('NAV-2'))
    expect(screen.queryByText('Root cause A')).toBeNull()
  })

  // Regression coverage: ReposSection holds pending/error chips in its own usePendingList()
  // state (component-instance state, not derived from props). If ReposSection is not remounted
  // on a slug change, a failed unlink in case A leaves an error chip that survives the switch to
  // case B and renders underneath case B's (correctly reloaded) repo list, misattributed to the
  // wrong case.
  it('does not leak a case A repo unlink-error chip into case B', async () => {
    window.argus.workspaces.list = vi.fn(async (slug: string) =>
      slug === 'NAV-1'
        ? [
            {
              path: 'C:\\repos\\hivemindtest',
              remote: null,
              branch: 'main',
              currentRef: 'main',
              dirty: false,
              worktreePath: null
            }
          ]
        : []
    ) as never
    window.argus.workspaces.unlink = vi.fn(() => Promise.reject(new Error('worktree is locked')))

    const { rerender } = render(workspace('NAV-1'))
    await screen.findByText('hivemindtest')
    fireEvent.click(screen.getByRole('button', { name: 'Unlink repo' }))
    expect(await screen.findByTitle('worktree is locked')).toBeInTheDocument()

    rerender(workspace('NAV-2'))

    await waitFor(() => expect(window.argus.workspaces.list).toHaveBeenCalledWith('NAV-2'))
    expect(screen.queryByTitle('worktree is locked')).toBeNull()
  })

  // Regression coverage: PrCompanionSection is the fourth per-case surface in this rail
  // (alongside ReposSection, CaseFiles, FindingsPane) and holds component-instance state of
  // its own — `linkingRef`, the PR identity shown while `pr:link` (a `git fetch` + `worktree
  // add`) is still running. A `PrCompanionSection`-only test cannot reproduce this: the leak
  // only exists because CaseWorkspace renders it with no `key`, so the SAME instance survives
  // a slug change and keeps showing case A's in-flight link under case B.
  it('does not leak case A’s in-flight PR-link identity into case B', async () => {
    let resolveLink!: (v: unknown) => void
    ;(window.argus.pr as unknown as { link: ReturnType<typeof vi.fn> }).link = vi.fn(
      () => new Promise((r) => (resolveLink = r))
    )
    const view = render(workspace('NAV-1', { activeMode: 'review' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'acme/web#42' } })
    fireEvent.submit(box)
    await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('NAV-1', 'acme/web#42'))
    // the optimistic identity is on screen while `pr:link` is still in flight
    expect(await screen.findByText('acme/web#42')).toBeInTheDocument()

    // switch case BEFORE case A's link resolves
    view.rerender(workspace('NAV-2', { activeMode: 'review' }))

    expect(screen.queryByText('acme/web#42')).toBeNull()
    resolveLink(undefined) // let the still-pending promise settle so it doesn't dangle
  })
})

describe('CaseWorkspace session bootstrap', () => {
  it('shows an inline error when sessions.list rejects, without crashing', async () => {
    window.argus.sessions.list = vi.fn(async () => {
      throw new Error('boom')
    })
    renderWorkspace()
    expect(await screen.findByText('Could not load chat sessions.')).toBeTruthy()
    // a genuine failure must NOT be dressed up as "this case has no chats"
    expect(screen.queryByText(/no chat sessions/i)).toBeNull()
  })

  // An ARCHIVED case has exactly zero sessions: archiving deletes them, and
  // sessionStore.listSessions reports that honestly instead of auto-creating one. The
  // bootstrap used to index `list[0].id` unconditionally, so the empty list threw a
  // TypeError inside the .then, the .catch above caught it, and the case rendered the red
  // load-failure line with no chat pane at all. `uiStore.activeSessions` is not persisted, so
  // this is the ordinary path after any restart — not an edge case. A fresh slug is used so
  // no earlier test's remembered session short-circuits the selection.
  it('renders an empty state, not the error banner, when the case has no chat sessions', async () => {
    window.argus.sessions.list = vi.fn(async () => [])

    render(workspace('NAV-ARCHIVED'))

    expect(await screen.findByText(/this case has no chat sessions/i)).toBeInTheDocument()
    expect(screen.queryByText('Could not load chat sessions.')).toBeNull()
    // and no chat pane was mounted over it (the composer is ChatPane's own child)
    expect(screen.queryByPlaceholderText('Message the analyst — / for skills')).toBeNull()
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
function sessionRow(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 1,
    title: '',
    turnCount: 0,
    updatedAt: '',
    driverKind: 'claude-agent-sdk',
    instanceId: null,
    model: null,
    mode: 'investigation',
    runOptions: [],
    permissionMode: null,
    historyOrphaned: false,
    ...over
  }
}

// Regression: the composer's chips are DERIVED from the workspace's session row (see
// handleModelChange's optimistic `.map`). SessionSwitcher used to keep its own copy of the
// list and refresh only that copy after creating a chat, so the workspace never learned the
// new row existed — `sessions.find(...)` returned undefined, `session` went null, and every
// chip silently refused to move until the user left the case and came back (which re-ran the
// `[slug]` load). Both now read one store, so a freshly created chat is pickable immediately.
describe('CaseWorkspace new chat', () => {
  it('lets the composer pin a model on a chat just created from the switcher', async () => {
    // The switcher reuses an untouched chat instead of minting one, so the existing chat needs
    // a turn for "New chat" to actually create — which is why this only bit intermittently.
    const rows: SessionSummary[] = [sessionRow({ id: 1, turnCount: 3 })]
    window.argus.sessions.list = vi.fn(async () => [...rows])
    window.argus.sessions.create = vi.fn(async () => {
      const created = sessionRow({ id: 3 })
      rows.push(created)
      return created
    })

    render(workspace('NAV-NEWCHAT'))
    await screen.findByRole('main')

    fireEvent.click(await screen.findByRole('button', { name: 'Switch chat' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(window.argus.agent.history).toHaveBeenCalledWith('NAV-NEWCHAT', 3))

    const before = screen.getByTitle('Model').textContent
    fireEvent.click(screen.getByTitle('Model'))
    const items = within(await screen.findByRole('menu', { name: 'Model' })).getAllByRole(
      'menuitem'
    )
    const other = items.find((i) => i.textContent !== before)
    expect(other).toBeTruthy()
    const picked = other!.textContent!
    fireEvent.click(other!)

    await waitFor(() =>
      expect(window.argus.sessions.setModel).toHaveBeenCalledWith(
        3,
        expect.any(String),
        expect.any(String)
      )
    )
    await waitFor(() => expect(screen.getByTitle('Model')).toHaveTextContent(picked))
  })
})

// Regression (Finding 1, permission-mode-auto residual review): sessionsSetModel resets a
// session's pinned permission_mode server-side when the new driver does not support it (e.g.
// 'auto' onto Copilot), but handleModelChange used to patch only { instanceId, model }
// optimistically and never learned the reconciled value. The permission-mode chip kept
// rendering 'Auto — Claude decides' off the stale session.permissionMode while the menu it
// opened was already built from the NEW instance's capabilities (no 'auto' entry) — a chip
// naming a mode its own menu can't offer. window.argus.sessions.setModel now resolves
// { changed, permissionMode }, and handleModelChange patches permissionMode from that once the
// round trip lands.
describe('CaseWorkspace permission-mode reconciliation on provider switch', () => {
  it('updates the permission-mode chip to match the mode the main process reconciled it to', async () => {
    window.argus.settings.get = vi.fn(async () => ({
      settings: settingsSchema.parse({
        agent: {
          activeInstanceId: 'claude-default',
          providerInstances: {
            'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
            'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
        }
      }),
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    window.argus.sessions.list = vi.fn(async () => [
      sessionRow({ instanceId: 'claude-default', model: 'claude-opus-4-8', permissionMode: 'auto' })
    ])
    // What main/index.ts's sessionsSetModel handler actually returns for this re-pin:
    // reconcilePermissionModeForDriver resets 'auto' to 'default' because Copilot's
    // capabilities are BASE_PERMISSION_MODES (no 'auto').
    window.argus.sessions.setModel = vi.fn(async () => ({
      changed: true,
      permissionMode: 'default' as const
    }))

    render(workspace('NAV-RECONCILE'))
    await screen.findByRole('main')

    expect(screen.getByTitle('Permission mode')).toHaveTextContent('Auto — Claude decides')

    fireEvent.click(screen.getByTitle('Model'))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Auto/ }))

    await waitFor(() =>
      expect(window.argus.sessions.setModel).toHaveBeenCalledWith(1, 'copilot-1', 'auto')
    )
    // The chip must stop claiming 'auto' once the reconciled value comes back...
    await waitFor(() =>
      expect(screen.getByTitle('Permission mode')).toHaveTextContent('Ask approvals')
    )
    // ...and the menu the chip opens must actually contain the mode it now shows (this is
    // what "invisible to the running UI" means: before the fix the chip kept saying 'Auto —
    // Claude decides' while this exact menu, built off the NEW instance, had no such item).
    fireEvent.click(screen.getByTitle('Permission mode'))
    const items = within(screen.getByRole('menu', { name: 'Permission mode' }))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(items).toContain('Ask approvals')
    expect(items).not.toContain('Auto — Claude decides')
  })
})

describe('CaseWorkspace mode switching', () => {
  // uiStore is a module-level singleton (not reset by beforeEach); these tests move
  // NAV-1's active session to 7, which would otherwise leak into later tests in this
  // file that assume the default single session (id 1).
  afterEach(() => {
    uiStore.setActiveSession('NAV-1', 1)
  })

  // ModeSwitcher (its click, its cases.setMode call, its busy/pressed rendering) moved to
  // TopBar and is covered there (TopBar.test.tsx) and at the component level
  // (ModeSwitcher.test.tsx). What's left for CaseWorkspace to own is the far side of the
  // wire: `caseBarStore.emit({ kind: 'mode-switched'|'mode-error', ... })` is what TopBar
  // sends once its ModeSwitcher's `cases.setMode` resolves or rejects — these tests emit
  // that event directly, the same contract TopBar exercises via the real click.
  function stubTwoModeSessions(): void {
    window.argus.sessions.list = vi.fn(async (): Promise<SessionSummary[]> => [
      {
        id: 1,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'investigation',
        runOptions: [],
        permissionMode: null,
        historyOrphaned: false
      },
      {
        id: 7,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'review',
        runOptions: [],
        permissionMode: null,
        historyOrphaned: false
      }
    ])
  }

  // uiStore.activeSessions is deliberately not persisted, so after a restart the bootstrap
  // falls back to the newest chat of ANY mode while activeMode comes from the DB. That
  // mismatch strands the user: ModeSwitcher.pick early-returns when the clicked mode is
  // already the active one, so there is no way to reach the right chat. A fresh slug is
  // used so no earlier test's activeSessions entry short-circuits the fallback.
  it('bootstraps to the newest chat of the case’s own mode, not the newest chat overall', async () => {
    window.argus.sessions.list = vi.fn(async (): Promise<SessionSummary[]> => [
      {
        id: 9, // newest overall, but the wrong mode
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'investigation',
        runOptions: [],
        permissionMode: null,
        historyOrphaned: false
      },
      {
        id: 7,
        title: '',
        turnCount: 0,
        updatedAt: '',
        driverKind: 'claude-agent-sdk',
        instanceId: null,
        model: null,
        mode: 'review',
        runOptions: [],
        permissionMode: null,
        historyOrphaned: false
      }
    ])

    render(workspace('NAV-BOOT', { activeMode: 'review' }))

    await waitFor(() => expect(window.argus.agent.history).toHaveBeenCalledWith('NAV-BOOT', 7))
    expect(window.argus.agent.history).not.toHaveBeenCalledWith('NAV-BOOT', 9)
  })

  // sessionsError replaces the whole chat, so a stale one from a rejected switch hides the
  // transcript indefinitely — including after the retry that succeeded.
  it('clears a previous switch error once a switch succeeds', async () => {
    renderWorkspace()
    await screen.findByRole('main')

    caseBarStore.emit({
      kind: 'mode-error',
      slug: 'NAV-1',
      message: 'Could not switch mode for this chat.'
    })
    expect(await screen.findByText('Could not switch mode for this chat.')).toBeTruthy()

    stubTwoModeSessions()
    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })
    await waitFor(() =>
      expect(screen.queryByText('Could not switch mode for this chat.')).toBeNull()
    )
  })

  /**
   * Rewritten with the indicator's new home. This used to assert the `caseBarStore` publish
   * that kept the bar's Review button spinning; the search now reports in the Pull request
   * rail, so the assertion is on rendered output in the real composition rather than on a
   * store hop. Rendered in review mode deliberately — that is the only mode in which
   * `PrCompanionSection` renders at all, and it is the mode this search happens in.
   */
  it('says it is searching while the PR search is in flight, instead of showing nothing', async () => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    await screen.findByRole('main')
    stubTwoModeSessions()
    let resolve!: (v: unknown) => void
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      () => new Promise((r) => (resolve = r))
    )

    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })

    const searching = await screen.findByText(/searching linked repos for pull requests/i)
    // The empty state must not be up at the same time — it states the one thing the search is
    // running to disprove.
    expect(screen.queryByText(/no pull request bound to this case yet/i)).toBeNull()

    resolve({ candidates: [], error: null, searchedRepos: ['x/y'] })
    await waitFor(() => expect(searching).not.toBeInTheDocument())
  })

  it('offers the PR picker after switching to review with nothing bound yet', async () => {
    renderWorkspace()
    await screen.findByRole('main')
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

    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })

    // the search runs only after the switch resolves, so the chat is never delayed by it
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    expect(await screen.findByRole('radio', { name: /16315/ })).toBeTruthy()
  })

  // Seen live 2026-08-02: switching to review on a case whose linked repo gh cannot search
  // raised the picker over the freshly-opened chat with zero rows and only Cancel to click.
  // Nobody asked for this search — it is a courtesy the mode switch runs on its own — so a
  // result with nothing to pick has nothing to say and must not interrupt. The Pull request
  // rail's "Find PRs" is the path where the user DID ask, and it still reports both states
  // (see the PrPickerDialog tests for the error/empty bodies it renders).
  it.each([
    ['a search error', { candidates: [], error: 'gh could not search that repo.' }],
    ['no matching PRs', { candidates: [], error: null }]
  ])('does not interrupt the review switch with an empty picker: %s', async (_label, result) => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    await screen.findByRole('main')
    stubTwoModeSessions()
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({ ...result, searchedRepos: ['mapbox/mapbox-navigator-debug-mcp'] })
    )

    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })
    // The rail's searching row going away is the signal the whole chain finished (it is driven
    // by the same `prSearching` flag the picker decision hangs off), so this cannot pass merely
    // by asserting before the dialog would have rendered. It replaces the bar-store busy state
    // that used to serve as that signal.
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    await waitFor(() =>
      expect(screen.queryByText(/searching linked repos for pull requests/i)).toBeNull()
    )
    expect(screen.queryByRole('dialog', { name: 'Link pull request' })).toBeNull()
  })

  it('does not offer the picker when the case already has bound PRs', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    stubTwoModeSessions()
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async () => [
      { id: 1, number: 16315 }
    ])

    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })
    await waitFor(() => expect(window.argus.pr.list).toHaveBeenCalledWith('NAV-1'))
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
    // Find PRs now lives in PrCompanionSection, which renders only in review mode.
    render(workspace('NAV-1', { activeMode: 'review' }))

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
    // Find PRs lives in PrCompanionSection now, which renders only in review mode — and its
    // own binding effect ALSO calls `pr.list(slug)` (on mount, and again when `slug` changes)
    // — a single shared resolver would get silently reassigned to whichever of those calls
    // happens to be pending, defeating the point of this test. Track every call instead, so
    // the ONE this test cares about (handlePrsFound's, for case A) can be resolved on its
    // own, independent of PrCompanionSection's mount-time call and its own refetch for case B
    // triggered by the switch below.
    const listResolvers: Array<(bound: unknown[]) => void> = []
    ;(window.argus.pr as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      () => new Promise((r) => listResolvers.push(r))
    )
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      async () => ({ candidates: oneCandidate, error: null, searchedRepos: ['acme/widget'] })
    )
    const view = render(workspace('NAV-1', { activeMode: 'review' }))
    await screen.findByRole('button', { name: 'Find PRs' })
    // resolve PrCompanionSection's own mount-time pr.list('NAV-1') call — irrelevant to this test
    listResolvers.shift()?.([])

    fireEvent.click(screen.getByRole('button', { name: 'Find PRs' }))
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    // handlePrsFound's own pr.list('NAV-1') call, now pending — capture ITS resolver before
    // switching, so the switch's own pr.list('NAV-2') call can't be confused with it
    await waitFor(() => expect(listResolvers.length).toBe(1))
    const resolveCaseA = listResolvers[0]

    // switch case BEFORE case A's in-flight lookup resolves
    view.rerender(workspace('NAV-2', { activeMode: 'review' }))

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
    const view = render(workspace('NAV-1', { activeMode: 'review' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Find PRs' }))
    await screen.findByRole('button', { name: /link selected/i }) // dialog is up for A

    view.rerender(workspace('NAV-2', { activeMode: 'review' }))
    expect(screen.queryByRole('button', { name: /link selected/i })).toBeNull()
    expect(window.argus.pr.link).not.toHaveBeenCalled()
  })

  // Re-review fix: `handlePrsFound` (the "Find PRs" button) got the case-switch guard above,
  // but `handleModeChanged`'s auto-search — entering review mode with nothing bound — is a
  // SECOND path that opens the same dialog and had the same defect, worse: it never called
  // `setPrPickerCurrent` at all, so it always rendered the dialog with `currentBinding: null`
  // even with no case switch involved — masked only because `bound.length` had already been
  // checked to be zero for the same slug moments earlier. Both paths now funnel through the
  // shared, guarded `openPrPicker`. Driven through a bar-emitted `mode-switched` event rather
  // than "Find PRs", mirroring the two tests above.
  it('drops a review-mode auto-search result that resolves after switching to a different case', async () => {
    stubTwoModeSessions()
    let resolveSearch!: (r: unknown) => void
    ;(window.argus.pr as unknown as { search: ReturnType<typeof vi.fn> }).search = vi.fn(
      () => new Promise((r) => (resolveSearch = r))
    )
    // default pr.list already resolves [] for any slug — matches "nothing bound yet" for A
    const view = render(workspace('NAV-1', { activeMode: 'investigation' }))
    await screen.findByRole('main')

    // simulates what TopBar emits once its ModeSwitcher's cases.setMode('NAV-1', 'review')
    // resolves
    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })
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

  // Re-review fix: `handlePrsFound` used to be `void`-ed, so PrCompanionSection's
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
    render(workspace('NAV-1', { activeMode: 'review' }))
    const findBtn = await screen.findByRole('button', { name: 'Find PRs' })

    fireEvent.click(findBtn)
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('NAV-1'))
    // pr.search has resolved, but the chain's own pr.list lookup hasn't — the control must
    // still read busy, not just while pr.search itself was in flight
    await waitFor(() => expect(findBtn).toBeDisabled())

    resolveList([])
    await waitFor(() => expect(findBtn).not.toBeDisabled())
  })

  it('calls onModeSwitched after a bar-emitted switch (the callback contract that keeps the parent’s case list — and so the activeMode prop — from going stale)', async () => {
    stubTwoModeSessions()
    const onModeSwitched = vi.fn()
    render(workspace('NAV-1', { activeMode: 'investigation', onModeSwitched }))
    await screen.findByRole('main')

    // simulates what TopBar's ModeSwitcher emits once its own cases.setMode('NAV-1', 'review')
    // resolves — that call itself, and the switcher's busy/pressed rendering, are
    // ModeSwitcher's contract now (ModeSwitcher.test.tsx / TopBar.test.tsx), not
    // CaseWorkspace's.
    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })

    // this is what actually closes the bug: it's App.tsx's signal to reload() its case
    // list, so the next time this prop is supplied it carries the real, persisted mode
    await waitFor(() => expect(onModeSwitched).toHaveBeenCalled())
    // the mode's chat (session 7, per the emitted event) is now the active session
    expect(uiStore.get().activeSessions['NAV-1']).toBe(7)
  })

  it('keeps the switched-to chat open across an unmount/remount once the parent has refreshed activeMode', async () => {
    stubTwoModeSessions()
    const { unmount } = render(workspace('NAV-1', { activeMode: 'investigation' }))
    await screen.findByRole('main')

    caseBarStore.emit({ kind: 'mode-switched', slug: 'NAV-1', mode: 'review', sessionId: 7 })
    await waitFor(() => expect(uiStore.get().activeSessions['NAV-1']).toBe(7))

    // simulate navigating home (CaseWorkspace fully unmounts — one branch of App.tsx's
    // view.kind ternary) and back. onModeSwitched fired above, so by the time the case is
    // reopened App.tsx's cases array — and thus this prop — carries the persisted mode.
    unmount()
    render(workspace('NAV-1', { activeMode: 'review' }))

    // the bootstrap effect resolves to the session that matches the (now refreshed)
    // activeMode prop — the same session the switch above actually opened, not a stale mirror
    await waitFor(() => expect(window.argus.agent.history).toHaveBeenCalledWith('NAV-1', 7))
    expect(uiStore.get().activeSessions['NAV-1']).toBe(7)
  })
})

// Product decision (conversation with the user, 2026-07-29): PR-linking controls (Link PR /
// Find PRs) are reachable only in review mode — "We don't need PR in investigation mode." This
// is deliberate, not an incidental consequence of where PrCompanionSection happens to sit in
// the layout. PrCompanionSection.test.tsx pins the same rule at the component level; this one
// exercises the real composition (CaseWorkspace always passes onPrsFound, so a future change
// that renders the section's header regardless of mode — a plausible refactor — would slip
// past the component-level test if it also loosened the mode gate there, but not past this one).
describe('CaseWorkspace PR linking is review-mode only', () => {
  it('shows neither Link PR nor Find PRs anywhere in investigation mode', async () => {
    render(workspace('NAV-1', { activeMode: 'investigation' }))
    await screen.findByText('Evidence') // wait for the workspace to settle before asserting absence
    expect(screen.queryByRole('button', { name: 'Link PR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Find PRs' })).not.toBeInTheDocument()
  })

  it('shows both Link PR and Find PRs in review mode', async () => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    expect(await screen.findByRole('button', { name: 'Link PR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find PRs' })).toBeInTheDocument()
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
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 900, buttons: 1 })
    expect(uiStore.get().findingsWidth).toBe(484)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    // after release, further moves change nothing — buttons: 1 (a genuine held button) so this
    // is caught only by onPointerUp's clearing of drag.current, not the buttons: 0 guard.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500, buttons: 1 })
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
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700, buttons: 1 })
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

  it('a pointer-cancel clears the drag so a later re-press does not resize the pane', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerCancel(sep, { pointerId: 1 })
    const before = uiStore.get().findingsWidth
    // A cancelled drag leaves the button up but never fires pointerUp. buttons: 1 here is a
    // genuine re-press — the `e.buttons === 0` guard would let this move through regardless of
    // onPointerCancel, so only onPointerCancel's clearing of drag.current can stop it.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500, buttons: 1 })
    expect(uiStore.get().findingsWidth).toBe(before)
  })

  // The evidence separator's own copy. Its twin above only pins the FINDINGS handler: the two
  // separators clear `drag.current` through separate onPointerCancel props, so deleting the one
  // on this side would otherwise go uncaught.
  it('a pointer-cancel clears the drag on the evidence separator too', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerCancel(sep, { pointerId: 1 })
    const before = uiStore.get().evidenceWidth
    // buttons: 1 is a genuine re-press, so the `e.buttons === 0` guard cannot be what stops
    // this — only onPointerCancel having cleared drag.current can.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1400, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(before)
  })

  it('a stray hover after pointerDown with no cancel/up does not resize the pane (buttons guard)', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    const before = uiStore.get().findingsWidth
    // No pointerCancel/pointerUp/lostPointerCapture fired — drag.current is still set. Only the
    // `e.buttons === 0` guard in onPointerMove can stop this stray hover from resizing.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500, buttons: 0 })
    expect(uiStore.get().findingsWidth).toBe(before)
  })

  it('losing pointer capture clears the drag so a later re-press does not resize the pane', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    // Simulates the OS handing pointer capture elsewhere without pointerup/pointercancel ever
    // firing. buttons: 1 on the follow-up move is a genuine re-press — the `e.buttons === 0`
    // guard would let it through regardless of this handler, so only onLostPointerCapture's
    // clearing of drag.current can stop it.
    fireEvent.lostPointerCapture(sep, { pointerId: 1 })
    const before = uiStore.get().findingsWidth
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500, buttons: 1 })
    expect(uiStore.get().findingsWidth).toBe(before)
  })

  it('offers a resize separator for each rail', async () => {
    renderWorkspace()
    expect(
      await screen.findByRole('separator', { name: 'Resize evidence pane' })
    ).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize findings pane' })).toBeInTheDocument()
  })

  // Mirrors the workspace-rail assertion above: the collapsed findings strip must not
  // regrow the hairline Task 3 removed from the expanded aside.
  it('collapsed strip carries no hairline border', async () => {
    uiStore.setFindingsCollapsed(true)
    renderWorkspace()
    const toggle = await screen.findByRole('button', { name: 'Expand findings' })
    expect(toggle.className).not.toContain('border-hair')
    expect(toggle.className).not.toContain('border-l')
  })
})

describe('CaseWorkspace evidence pane drag', () => {
  it('drag on the separator resizes the pane (rightwards widens) and leaves findings alone', () => {
    const { container } = renderWorkspace()
    // jsdom never lays out the page, so <main> reports clientWidth 0; the drag handle
    // clamps against it (Task 5 pane-overlap guard). Stub a roomy viewport so this test
    // still exercises plain resize math — the clamp itself is covered separately below.
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1100, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(420)
    // the evidence handler must write evidenceWidth, never findingsWidth — a copy-pasted
    // wrong setter would still typecheck (both are `(number) => void`) but would show up here
    expect(uiStore.get().findingsWidth).toBe(384)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    // after release, further moves change nothing — buttons: 1 (a genuine held button) so this
    // is caught only by onPointerUp's clearing of drag.current, not the buttons: 0 guard.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1300, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(420)
  })

  it('drag cannot widen the evidence pane past what leaves chat its minimum width', () => {
    const { container } = renderWorkspace()
    // Narrow main column (500px): chat can give up at most 500 - CHAT_MIN_WIDTH (360) = 140px,
    // so evidence should clamp at 320 + 140 = 460 even though the pointer travels further.
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 500
    })
    const sep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1300, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(460)
    fireEvent.pointerUp(sep, { pointerId: 1 })
  })

  it('ignores a move meant for the other rail’s drag, and still works afterwards', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const findingsSep = screen.getByRole('separator', { name: 'Resize findings pane' })
    const evidenceSep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    // start a findings drag, but move on the evidence separator — the shared `drag` ref's
    // `side` guard must keep the evidence handler dead for this move
    fireEvent.pointerDown(findingsSep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(evidenceSep, { pointerId: 1, clientX: 1100, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(320)
    fireEvent.pointerUp(findingsSep, { pointerId: 1 })
    // the findings drag itself still works after that stray move
    fireEvent.pointerDown(findingsSep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(findingsSep, { pointerId: 1, clientX: 900, buttons: 1 })
    expect(uiStore.get().findingsWidth).toBe(484)
    fireEvent.pointerUp(findingsSep, { pointerId: 1 })
  })

  it('a stray hover after pointerDown with no cancel/up does not resize the pane (buttons guard)', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    const before = uiStore.get().evidenceWidth
    // No pointerCancel/pointerUp/lostPointerCapture fired — drag.current is still set. Only the
    // `e.buttons === 0` guard in onPointerMove can stop this stray hover from resizing.
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1300, buttons: 0 })
    expect(uiStore.get().evidenceWidth).toBe(before)
  })

  it('losing pointer capture clears the drag so a later re-press does not resize the pane', () => {
    const { container } = renderWorkspace()
    Object.defineProperty(container.querySelector('main')!, 'clientWidth', {
      configurable: true,
      value: 2000
    })
    const sep = screen.getByRole('separator', { name: 'Resize evidence pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    // Simulates the OS handing pointer capture elsewhere without pointerup/pointercancel ever
    // firing. buttons: 1 on the follow-up move is a genuine re-press — the `e.buttons === 0`
    // guard would let it through regardless of this handler, so only onLostPointerCapture's
    // clearing of drag.current can stop it.
    fireEvent.lostPointerCapture(sep, { pointerId: 1 })
    const before = uiStore.get().evidenceWidth
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 1300, buttons: 1 })
    expect(uiStore.get().evidenceWidth).toBe(before)
  })
})

describe('CaseWorkspace workspace pane', () => {
  it('collapse hides the pane and the edge button expands it back', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse workspace' }))
    expect(screen.queryByRole('button', { name: 'Collapse workspace' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace' }))
    expect(uiStore.get().evidenceCollapsed).toBe(false)
    expect(screen.getByRole('button', { name: 'Collapse workspace' })).toBeTruthy()
  })

  // The whole point of moving the toggle out of ReposSection: its y was a fact about the
  // rail's content, so a case with a Jira ticket pushed it down and scrolling took it away.
  // Assert the structural property jsdom CAN see — the toggle is the rail's own first child,
  // not a descendant of any section, and not inside the scrolling box.
  it('puts the collapse toggle in the rail chrome row, outside the scroll container', async () => {
    const { container } = renderWorkspace()
    const toggle = await screen.findByRole('button', { name: 'Collapse workspace' })
    const aside = container.querySelector('aside')!
    expect(toggle.parentElement?.parentElement).toBe(aside)
    expect(aside.firstElementChild).toBe(toggle.parentElement)
    expect(toggle.closest('.overflow-y-auto')).toBeNull()
  })

  // Minor 4: half this branch's purpose is the max-h-[55%] cap on the rail's upper scroll box
  // (see the arithmetic comment above that `<div>` in CaseWorkspace.tsx) — nothing else in this
  // file guards its presence. jsdom cannot prove the cap actually bounds anything (no layout),
  // but it CAN prove the class survived, which is what a "tidy the classes" refactor would
  // silently undo without any layout test ever catching it.
  it('caps the rail scroll box at max-h-[55%] so evidence keeps a share of the rail', async () => {
    const { container } = renderWorkspace()
    await screen.findByRole('button', { name: 'Collapse workspace' })
    // The workspace/evidence aside, same element the toggle test above resolves via
    // `container.querySelector('aside')` (it is first in document order).
    const aside = container.querySelector('aside')!
    const scrollBox = aside.querySelector('.overflow-y-auto')
    expect(scrollBox).not.toBeNull()
    expect(scrollBox!.className).toMatch(/(^|\s)max-h-\[55%\](\s|$)/)
  })

  // Task 3 dropped the hairline border from the two EXPANDED asides so the three columns
  // read as peers on one ground plane, but left it on the collapsed strips — collapsing
  // either rail brought the hairline back. The collapsed strip is this button itself.
  it('collapsed strip carries no hairline border', async () => {
    uiStore.setEvidenceCollapsed(true)
    renderWorkspace()
    const toggle = await screen.findByRole('button', { name: 'Expand workspace' })
    expect(toggle.className).not.toContain('border-hair')
    expect(toggle.className).not.toContain('border-r')
  })
})

describe('CaseWorkspace rail material', () => {
  it('goes to ground (dyn-rail, not bg-void) when the dynamic theme is on', async () => {
    uiStore.setDynamicTheme(true)
    const { container } = renderWorkspace()
    // 'Chat' was the static tab label pre-merge; the tab strip's Chat tab is now the
    // active chat's own title (SessionSwitcher's trigger) — see task-4-report.md.
    await screen.findByLabelText('Chat 1')
    const asides = container.querySelectorAll('aside')
    expect(asides.length).toBeGreaterThan(0)
    asides.forEach((a) => {
      expect(a.className).toContain('dyn-rail')
      expect(a.className).not.toContain('bg-void')
    })
  })

  // Task 8b: the false branch repaints ground with bg-void (not bg-deep), so the
  // viewport-anchored --wash gradient (which matches only :is(body, .bg-void)) reaches these
  // rails too when the dynamic theme is off.
  it('stays bg-void when the dynamic theme is off', async () => {
    uiStore.setDynamicTheme(false)
    const { container } = renderWorkspace()
    await screen.findByLabelText('Chat 1')
    const asides = container.querySelectorAll('aside')
    expect(asides.length).toBeGreaterThan(0)
    asides.forEach((a) => {
      expect(a.className).toContain('bg-void')
      expect(a.className).not.toContain('dyn-rail')
    })
  })
})

describe('CaseWorkspace rail section collapse', () => {
  it('keeps a rail section collapsed across a case switch', async () => {
    const { rerender } = render(workspace('NAV-1'))
    await screen.findByRole('main')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Repos' }))
    rerender(workspace('OTHER-2'))

    // The rail sections remount on `key={slug}`, so this passes only because the flag lives in
    // uiStore rather than in component state.
    expect(await screen.findByRole('button', { name: 'Expand Repos' })).toBeInTheDocument()
  })
})

describe('CaseWorkspace panel tab host', () => {
  it('shows a Chat tab and lists available panels in the launcher', async () => {
    renderWorkspace()
    expect(await screen.findByLabelText('Chat 1')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('New panel'))
    expect(await screen.findByText('Text Viewer')).toBeTruthy()
  })
})

// findOpen/onOpenFind/onFindOpenChange are the wiring that connects the bar's find button
// (PanelTabStrip) to the in-transcript overlay (ChatFind, rendered by ChatPane) — all three
// props are optional, so a regression that drops any one of them typecheck-checks and every
// component-level suite (PanelTabStrip.test.tsx proves *a* callback fires; ChatPane.test.tsx
// proves a harness's own state drives the overlay) stays green while the feature silently
// dies in the real tree. This is the one test that renders the real composition end to end.
describe('CaseWorkspace find wiring', () => {
  it('wires the bar find button to open ChatFind over the transcript', async () => {
    renderWorkspace()
    await screen.findByLabelText('Chat 1')
    expect(screen.queryByLabelText('Find in chat')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByLabelText('Find in transcript'))

    expect(await screen.findByLabelText('Find in chat')).toBeInTheDocument()
  })

  // Minor 4: CaseWorkspace is never remounted on a slug change (the `slug !== lastSlug`
  // block above patches state in place), so a find left open on case A would otherwise
  // reopen unbidden on case B, which never asked for it — the old local ChatPane state
  // used to die with the unmount; the lifted state does not.
  it('closes an open find overlay when switching to a different case', async () => {
    const view = renderWorkspace()
    await screen.findByLabelText('Chat 1')
    fireEvent.click(await screen.findByLabelText('Find in transcript'))
    expect(await screen.findByLabelText('Find in chat')).toBeInTheDocument()

    view.rerender(workspace('NAV-2'))

    await screen.findByLabelText('Chat 1')
    expect(screen.queryByLabelText('Find in chat')).not.toBeInTheDocument()
  })
})

describe('evidence section per mode', () => {
  it('review mode: relabeled to Code review artifacts, no search, no similar cases', async () => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    expect(await screen.findByText('Code review artifacts')).toBeInTheDocument()
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/search evidence/i)).not.toBeInTheDocument()
    // CaseFiles itself (the files list) still renders under the relabeled section.
    expect(screen.getByRole('button', { name: 'Rescan evidence folder' })).toBeInTheDocument()
  })

  it('does not render a second files header inside the section', async () => {
    render(workspace('NAV-1', { activeMode: 'review' }))
    await screen.findByText('Code review artifacts')
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
  })

  it('investigation mode: Evidence label and search stay', async () => {
    render(workspace('NAV-1', { activeMode: 'investigation' }))
    expect(await screen.findByText('Evidence')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/search evidence/i)).toBeInTheDocument()
  })
})

describe('CaseWorkspace: archived case', () => {
  // `archivedAt` is OPTIONAL on both CaseWorkspace and CaseFiles, so the one line that threads
  // it (`archivedAt={archivedAt ?? null}` on the CaseFiles element) could be deleted with the
  // whole renderer suite and `tsc -p tsconfig.web.json` still green — while the archived
  // evidence pane became unreachable in the real app. These two tests are the wire.
  it('threads archivedAt down to the evidence pane', async () => {
    renderWorkspace({ archivedAt: '2026-08-28T00:00:00Z' })
    // The archived state is CaseFiles' own; seeing it here proves the value arrived.
    expect(await screen.findByTestId('evidence-archived')).toBeInTheDocument()
    expect(screen.queryByText('No evidence yet.')).toBeNull()
  })

  it('leaves the ordinary empty state alone on a live case', async () => {
    renderWorkspace()
    expect(await screen.findByText('No evidence yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('evidence-archived')).toBeNull()
  })

  it('restores through the evidence pane and reports a failure as a notice', async () => {
    // The other half of the same wire: the pane's Restore action must reach the IPC bridge, and
    // its rejection must surface rather than being swallowed into a button that just re-enables.
    window.argus.cases.restore = vi.fn(async () => {
      throw new Error('bundle checksum mismatch')
    })
    noticeStore.reset()
    renderWorkspace({ archivedAt: '2026-08-28T00:00:00Z' })
    fireEvent.click(await screen.findByRole('button', { name: 'Restore from archive' }))
    await vi.waitFor(() => expect(window.argus.cases.restore).toHaveBeenCalledWith('NAV-1'))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe('bundle checksum mismatch')
  })
})
