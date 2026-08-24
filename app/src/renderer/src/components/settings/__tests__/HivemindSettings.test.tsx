// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HivemindSettings } from '../HivemindSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import { connectorsStore } from '../../../lib/connectorsStore'
import { currencyStore } from '../../../lib/currencyStore'
import { confirm } from '../../../lib/confirmStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { HivemindItem, HivemindPayload, LocalDivergence } from '../../../../../shared/hivemind'
import type { SettingsPayload } from '../../../../../shared/settings'
import type { CurrencyPayload } from '../../../../../shared/currency'

// Uninstall/keep-as-mine go through the Argus confirm dialog (imported as askConfirm in the
// component). Stub it so these tests drive the confirm/cancel branches directly.
vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

function settingsPayload(repo: string): SettingsPayload {
  return {
    settings: { ...defaultSettings(), hivemind: { repo } },
    resolvedTools: [],
    dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
    loadError: null
  }
}

const ready: HivemindPayload = {
  repo: 'acme/hivemind',
  state: 'ready',
  error: null,
  headCommit: 'headsha1234567',
  lastSynced: '2026-07-10T12:00:00.000Z',
  items: [
    {
      kind: 'skill',
      name: 'hive-probe',
      description: 'probe skill',
      author: null,
      commit: 'sha-2',
      installed: true,
      installedCommit: 'sha-1',
      localTier: null,
      shadowedByUser: false,
      updateAvailable: true,
      orphaned: false,
      declined: false
    },
    {
      kind: 'reference',
      name: 'hive-note.md',
      description: '',
      author: null,
      commit: 'sha-3',
      installed: false,
      installedCommit: null,
      localTier: null,
      shadowedByUser: false,
      updateAvailable: false,
      orphaned: false,
      declined: false
    }
  ],
  pushable: [{ kind: 'skill', name: 'my-skill' }],
  pushes: {}
}

// Shared handles so 'update hazards' tests can assert on call args / control resolution
// without drilling through the window.argus cast on every assertion.
const installMock = vi.fn()
const localDivergenceMock = vi.fn<(name: string) => Promise<LocalDivergence>>()

// Task 13: the auto-sync effect now rate-limits itself through the currency service's
// surveyNow('hive') instead of calling hivemind.sync() directly, then re-reads via
// hivemind.get() the same way the component already does elsewhere. Declared once, outside
// mockArgus, so 'does not lock the panel while auto-syncing' can override just this one method
// (mirroring how it overrides hivemind.sync today) without losing the rest of the stub.
const surveyNowMock = vi.fn().mockResolvedValue(undefined)

function mockArgus(payload: HivemindPayload): Record<string, unknown> {
  installMock.mockResolvedValue(payload)
  return {
    currency: {
      get: vi.fn().mockResolvedValue({ auto: true, lastSurveyAt: null, blocked: [], busy: false }),
      surveyNow: surveyNowMock,
      onChanged: vi.fn(() => () => undefined)
    },
    hivemind: {
      get: vi.fn().mockResolvedValue(payload),
      sync: vi.fn().mockResolvedValue(payload),
      install: installMock,
      claimReference: vi.fn().mockResolvedValue(payload),
      uninstallSkill: vi.fn().mockResolvedValue(payload),
      uninstallReference: vi.fn().mockResolvedValue(payload),
      diff: vi
        .fn()
        .mockResolvedValue(
          'diff --git a/skills/x b/skills/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new'
        ),
      localDivergence: localDivergenceMock,
      pushPreview: vi.fn().mockResolvedValue('# my-skill'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/7' }),
      check: vi.fn().mockResolvedValue({ ok: true })
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: '2.62',
        authenticated: true,
        login: 'me',
        detail: ''
      })
    },
    // The Team page pairs the HiveMind repo with Confluence sync (2026-08-01), so
    // `ConfluenceSpaces` now mounts here and needs its two stores fed. Empty payloads: this
    // suite is about the HiveMind half, and SourcesPage.test.tsx / ConfluenceSpaces' own suite
    // cover the Confluence half.
    refsync: {
      get: vi.fn().mockResolvedValue({
        config: { spaces: [], outdatedWindowMonths: 12, mustKeep: {} },
        loadError: null,
        cards: [],
        references: []
      }),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined)
    },
    // Confluence is dormant unless an installed pack declares reference-routing rules
    // (2026-08-08). One rule here, so the section renders for the suite below exactly as it did
    // before the gate existed; the gate's own two outcomes are asserted directly.
    packs: {
      referenceRouting: vi.fn().mockResolvedValue([{ keywords: ['adasis'], target: 'adasis.md' }])
    },
    // An AUTHORIZED rovo connector, not an empty payload: with none configured,
    // `ConfluenceSpaces` renders its own `role="alert"` warning, and the several tests below
    // that assert on `getByRole('alert')` would then match two banners instead of the
    // HiveMind one they are about.
    connectors: {
      get: vi.fn().mockResolvedValue({
        connectors: {
          rovo: {
            kind: 'http',
            displayName: 'Atlassian Rovo',
            preset: 'rovo',
            enabled: true,
            config: {
              url: 'https://mcp.atlassian.com/v1/mcp/authv2',
              transport: 'http',
              oauth: true
            }
          }
        },
        runtime: {},
        oauth: { rovo: 'authorized' },
        rest: {},
        loadError: null,
        secretsAvailable: true,
        secretsLoadError: null,
        presets: {}
      }),
      onChanged: vi.fn(() => () => undefined)
    },
    openExternal: vi.fn()
  }
}

function renderWith(payload: HivemindPayload): ReturnType<typeof render> {
  ;(window as unknown as { argus: unknown }).argus = mockArgus(payload)
  return render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
}

/**
 * Renders the page, optionally overriding the item list (defaults to `ready`'s) and the currency
 * payload `window.argus.currency.get()` resolves to (the held-back list the chips, reason line,
 * and section badge read). The one render helper this file has for the currency-aware tests —
 * extend it rather than adding a second.
 */
function renderHive(
  options: { items?: HivemindItem[]; currency?: CurrencyPayload } = {}
): ReturnType<typeof render> {
  const payload: HivemindPayload = options.items ? { ...ready, items: options.items } : ready
  const argus = mockArgus(payload) as unknown as { currency: { get: ReturnType<typeof vi.fn> } }
  if (options.currency) {
    const currency = options.currency
    argus.currency.get = vi.fn().mockResolvedValue(currency)
  }
  ;(window as unknown as { argus: unknown }).argus = argus
  return render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
}

/** A minimal HivemindItem, overridable per test — the one item fixture factory for this file. */
function item(overrides: Partial<HivemindItem> = {}): HivemindItem {
  return {
    kind: 'skill',
    name: 'item',
    description: '',
    author: null,
    commit: 'sha',
    installed: false,
    installedCommit: null,
    localTier: null,
    shadowedByUser: false,
    updateAvailable: false,
    orphaned: false,
    declined: false,
    ...overrides
  }
}

beforeEach(() => {
  // Both are module-level singletons that latch after their first load; without a reset they
  // carry another suite's payload (and its stale `window.argus`) into this one.
  referenceSyncStore.reset()
  connectorsStore.reset()
  // currencyStore is a module-level singleton too — without resetting it here, a later test's
  // `currencyStore.start()` would find `started` still true from a previous test and skip
  // re-hydrating from this test's own stub entirely.
  currencyStore.reset()
  installMock.mockClear()
  surveyNowMock.mockClear()
  localDivergenceMock.mockReset().mockResolvedValue({ diverged: false, diff: '', tierChange: null })
  ;(window as unknown as { argus: unknown }).argus = mockArgus(ready)
  vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined as never)
})

describe('HivemindSettings', () => {
  it('dormant state shows the repo input, not a pointer to General', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      repo: '',
      state: 'dormant',
      items: [],
      headCommit: null
    })
    render(<HivemindSettings payload={settingsPayload('')} />)
    expect(await screen.findByText(/Set a HiveMind repo/)).toBeInTheDocument()
    expect(screen.queryByText(/General/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('HiveMind repo')).toBeInTheDocument()
  })

  /**
   * The Team page's two upstreams (2026-08-01, user-directed): the HiveMind repo and Confluence,
   * as a left and a right panel. Asserted on the dormant path too, because Confluence sync does
   * not depend on a HiveMind repo — hiding it behind one would strand a user who has only
   * Confluence configured.
   */
  it('pairs Repository with Confluence, even before a repo is set', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      repo: '',
      state: 'dormant',
      items: [],
      headCommit: null
    })
    render(<HivemindSettings payload={settingsPayload('')} />)
    expect(await screen.findByText('Repository')).toBeInTheDocument()
    expect(await screen.findByText('Confluence')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Confluence space' })).toBeInTheDocument()
  })

  /**
   * The gate (user-directed, 2026-08-08): a synced Confluence page only lands anywhere once a
   * routing rule says which reference file it belongs in, and packs are where those rules come
   * from — so an install with no pack declaring any has nothing for the feature to do.
   *
   * `findByText('Repository')` first, not a bare `queryByText`: the section is hidden while the
   * `referenceRouting` call is still in flight, so asserting absence on the first frame would
   * pass whatever the answer turned out to be.
   */
  it('hides Confluence when no installed pack declares reference-routing rules', async () => {
    // `mockArgus`'s return type is inferred structurally and widens these to `unknown`; the
    // suite's established shape for reaching into it is a cast at the call site.
    const argus = mockArgus(ready) as unknown as {
      packs: { referenceRouting: ReturnType<typeof vi.fn> }
      refsync: { get: ReturnType<typeof vi.fn> }
    }
    argus.packs.referenceRouting.mockResolvedValue([])
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('Repository')).toBeInTheDocument()
    await waitFor(() => expect(argus.packs.referenceRouting).toHaveBeenCalled())
    expect(screen.queryByText('Confluence')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Confluence space' })).not.toBeInTheDocument()
  })

  /** A space someone already set up keeps the section, whatever any pack declares — otherwise the
   *  gate would strand existing configuration (and its Remove button) rather than tidy it. */
  it('keeps Confluence when a space is already configured and no pack declares rules', async () => {
    const argus = mockArgus(ready) as unknown as {
      packs: { referenceRouting: ReturnType<typeof vi.fn> }
      refsync: { get: ReturnType<typeof vi.fn> }
    }
    argus.packs.referenceRouting.mockResolvedValue([])
    argus.refsync.get.mockResolvedValue({
      config: {
        spaces: [{ key: 'ENG', name: 'Engineering', homepageId: '1' }],
        outdatedWindowMonths: 12,
        mustKeep: {}
      },
      loadError: null,
      cards: [],
      references: []
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('Confluence')).toBeInTheDocument()
  })

  it('repo row commits hivemind.repo on blur', async () => {
    render(<HivemindSettings payload={settingsPayload('')} />)
    const input = await screen.findByLabelText('HiveMind repo')
    fireEvent.change(input, { target: { value: 'acme/hivemind' } })
    fireEvent.blur(input)
    expect(settingsStore.patch).toHaveBeenCalledWith({ hivemind: { repo: 'acme/hivemind' } })
  })

  /**
   * The repo status row has to stay inside its own column.
   *
   * It was one non-wrapping flex line, written when this section owned the whole content
   * column. Paired with Confluence at half width (2026-08-01) it no longer fit — and a flex
   * line that does not fit spills rather than clips, so the tail of "synced <date>, <time>"
   * rendered outside the card, on top of the Confluence panel next to it.
   *
   * jsdom resolves no layout, so this asserts the STRUCTURE that makes overflow impossible
   * (the same contract-on-the-source idiom `settingsLayout.test.tsx` uses): the identity and
   * the status chips are separate stacked rows, and the long repo string truncates instead of
   * pushing the line wider.
   */
  it('keeps the repo status inside its column instead of spilling out of the card', async () => {
    const long = 'JiaweiHan88/an-extremely-long-hivemind-repository-name-that-will-not-fit'
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      repo: long,
      lastSynced: '2026-07-22T15:02:43.000Z'
    })
    render(<HivemindSettings payload={settingsPayload(long)} />)

    const identity = await screen.findByRole('button', { name: `Open ${long} on GitHub` })
    // The repo name elides; it does not widen the row.
    expect(identity.querySelector('.truncate')?.textContent).toBe(long)
    // Sync shares the identity's line...
    const identityRow = identity.parentElement!
    expect(identityRow.querySelector('[aria-label="Sync"]')).not.toBeNull()
    // ...and the status chips sit on a DIFFERENT, wrapping row rather than extending it.
    const syncedAt = screen.getByText(/^synced /)
    expect(identityRow.contains(syncedAt)).toBe(false)
    expect(syncedAt.parentElement!.className).toContain('flex-wrap')
  })

  it('not-cloned state offers Sync', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      state: 'not-cloned',
      items: [],
      headCommit: null
    })
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByRole('button', { name: 'Sync' })).toBeInTheDocument()
  })

  it('ready state lists items under separate Skills/References headings, flags updates, installs on click', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('References')).toBeInTheDocument()
    expect(screen.getByText('update available')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download hive-note.md' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('reference', 'hive-note.md')
    )
  })

  it('update flow expands the diff directly below the clicked row and re-installs through it', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const row = await screen.findByText('hive-probe')
    fireEvent.click(screen.getByRole('button', { name: 'Update hive-probe' }))
    // real @@-bearing diff renders the split view, not the plain <pre> fallback
    expect(await screen.findByRole('group', { name: 'diff view mode' })).toBeInTheDocument()
    const diff = await screen.findByText('old')
    expect(await screen.findByText('new')).toBeInTheDocument()
    // inline placement: the diff panel follows the item's row in DOM order
    expect(row.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-download hive-probe' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('skill', 'hive-probe')
    )
  })

  it('filter input narrows visible rows by name and description', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')
    expect(screen.getByText('hive-note.md')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: 'probe' }
    })

    expect(screen.getByText('hive-probe')).toBeInTheDocument()
    expect(screen.queryByText('hive-note.md')).not.toBeInTheDocument()
    // no reference items match "probe" — the References section disappears entirely
    expect(screen.queryByText('References')).not.toBeInTheDocument()
  })

  it('no-match state shows dim message when filter matches nothing in both lists', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')

    // Type non-matching filter
    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: 'zzz' }
    })

    // Both lists should be empty, no-match message should appear
    expect(screen.getByText('No HiveMind content matches "zzz".')).toBeInTheDocument()
    expect(screen.queryByText('hive-probe')).not.toBeInTheDocument()
    expect(screen.queryByText('hive-note.md')).not.toBeInTheDocument()

    // Clear filter - rows come back
    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: '' }
    })

    expect(screen.queryByText('No HiveMind content matches')).not.toBeInTheDocument()
    expect(screen.getByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByText('hive-note.md')).toBeInTheDocument()
  })

  it('renders Browse content directly — the tab strip and Share tab are gone', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByText('Share to HiveMind')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Filter HiveMind content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync' })).toBeInTheDocument()
  })

  // Superseded (Important, fix-wave review of 84b09df0): this used to assert the mount effect
  // painted `p.error` as an alert banner — but that field describes the CLONE's state (a
  // possibly-stale `lastSyncError`), not an outcome of this particular mount, and a stale one
  // would then repaint the same banner on every visit to the tab indefinitely. The status chip
  // is the correct, non-alarming surface for it; only the Sync button's own attempt should alert.
  it('shows the error status chip, not an alert, for an initial-load payload error', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
      ...ready,
      state: 'error',
      error: 'clone diverged',
      items: [],
      pushable: []
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces a rejected diff fetch when opening the update flow', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { diff: ReturnType<typeof vi.fn> }).diff = vi
      .fn()
      .mockRejectedValue(new Error('git exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update hive-probe' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/git exploded/)
    expect(screen.queryByText('+ new line')).not.toBeInTheDocument()
  })

  it('unauthenticated gh renders the Health pointer without hiding the browse list', async () => {
    const argus = mockArgus(ready)
    ;(argus.sourceControl as { status: ReturnType<typeof vi.fn> }).status = vi
      .fn()
      .mockResolvedValue({
        installed: false,
        version: null,
        authenticated: false,
        login: null,
        detail: ''
      })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText(/GitHub CLI/)).toBeInTheDocument()
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
  })

  it('refetches the hivemind payload when the repo setting changes', async () => {
    // Task 13: hivemind.get() is now called TWICE per repo-load cycle — once directly by this
    // effect, and once more when the auto-sync effect's currency.surveyNow('hive') resolves and
    // chains into hivemind.get() to pick up the refreshed payload. So each repo change now
    // contributes 2 calls, not 1.
    const { rerender } = render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    await waitFor(() => expect(window.argus.hivemind.get).toHaveBeenCalledTimes(2))
    rerender(<HivemindSettings payload={settingsPayload('org/other')} />)
    await waitFor(() => expect(window.argus.hivemind.get).toHaveBeenCalledTimes(4))
  })

  it('shows readiness feedback for the configured repo', async () => {
    window.argus.hivemind.check = vi.fn().mockResolvedValue({ ok: false, error: 'no access' })
    render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    expect(await screen.findByText('not reachable')).toBeInTheDocument()
  })

  it('renders the repo as an external link for org/name slugs', async () => {
    render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    fireEvent.click(await screen.findByRole('button', { name: /open org\/hive on github/i }))
    expect(window.argus.openExternal).toHaveBeenCalledWith('https://github.com/org/hive')
  })
})

describe('uninstall skill', () => {
  const installed: HivemindPayload = {
    ...ready,
    items: [
      { ...ready.items[0], updateAvailable: false }, // installed skill, up to date
      { ...ready.items[0], name: 'hive-extra', installed: false, installedCommit: null },
      ready.items[1] // uninstalled reference
    ]
  }

  afterEach(() => vi.restoreAllMocks())

  it('uninstalls an installed skill after confirm', async () => {
    const argus = mockArgus(installed)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-probe' }))
    await waitFor(() =>
      expect(
        (argus.hivemind as { uninstallSkill: ReturnType<typeof vi.fn> }).uninstallSkill
      ).toHaveBeenCalledWith('hive-probe')
    )
  })

  it('confirm-cancel is a no-op', async () => {
    const argus = mockArgus(installed)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(false)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-probe' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(
      (argus.hivemind as { uninstallSkill: ReturnType<typeof vi.fn> }).uninstallSkill
    ).not.toHaveBeenCalled()
  })

  it('offers Remove only for downloaded skills, never references', async () => {
    const argus = mockArgus(installed)
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove hive-probe' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove hive-extra' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove hive-note.md' })).not.toBeInTheDocument()
  })

  it('a rejected uninstall surfaces in the alert banner', async () => {
    const argus = mockArgus(installed)
    ;(argus.hivemind as { uninstallSkill: ReturnType<typeof vi.fn> }).uninstallSkill = vi
      .fn()
      .mockRejectedValue(new Error('uninstall exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-probe' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/uninstall exploded/)
  })
})

describe('uninstall reference', () => {
  const withRefs: HivemindPayload = {
    ...ready,
    items: [
      { ...ready.items[1], installed: true, installedCommit: 'sha-3', localTier: 'hivemind' },
      {
        ...ready.items[1],
        name: 'confluence/adasis.md',
        installed: true,
        installedCommit: 'sha-4',
        localTier: 'confluence'
      },
      { ...ready.items[1], name: 'mine.md', installed: true, localTier: 'user' },
      { ...ready.items[1], name: 'ghost.md' } // not installed
    ]
  }

  afterEach(() => vi.restoreAllMocks())

  it('uninstalls a hivemind-tier reference after confirm', async () => {
    const argus = mockArgus(withRefs)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-note.md' }))
    await waitFor(() =>
      expect(
        (argus.hivemind as { uninstallReference: ReturnType<typeof vi.fn> }).uninstallReference
      ).toHaveBeenCalledWith('hive-note.md')
    )
  })

  it('offers Remove for confluence-tier but never user-tier or undownloaded refs', async () => {
    const argus = mockArgus(withRefs)
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-note.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove confluence/adasis.md' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove mine.md' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove ghost.md' })).not.toBeInTheDocument()
  })

  it('confirm-cancel is a no-op', async () => {
    const argus = mockArgus(withRefs)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(false)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-note.md' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(
      (argus.hivemind as { uninstallReference: ReturnType<typeof vi.fn> }).uninstallReference
    ).not.toHaveBeenCalled()
  })

  it('a rejected uninstall surfaces in the alert banner', async () => {
    const argus = mockArgus(withRefs)
    ;(argus.hivemind as { uninstallReference: ReturnType<typeof vi.fn> }).uninstallReference = vi
      .fn()
      .mockRejectedValue(new Error('ref uninstall exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove hive-note.md' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/ref uninstall exploded/)
  })
})

describe('keep as mine', () => {
  const claimable: HivemindPayload = {
    ...ready,
    items: [
      {
        kind: 'reference',
        name: 'hive-note.md',
        description: '',
        author: null,
        commit: 'sha-3',
        installed: true,
        installedCommit: 'sha-3',
        localTier: 'hivemind',
        shadowedByUser: false,
        updateAvailable: false,
        orphaned: false,
        declined: false
      }
    ]
  }

  afterEach(() => vi.restoreAllMocks())

  it('claims an installed hivemind-tier reference after confirm', async () => {
    const argus = mockArgus(claimable)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    await waitFor(() =>
      expect(
        (argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference
      ).toHaveBeenCalledWith('hive-note.md')
    )
  })

  it('confirm-cancel is a no-op', async () => {
    const argus = mockArgus(claimable)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(false)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(
      (argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference
    ).not.toHaveBeenCalled()
  })

  it('hides the button for user-tier and uninstalled references', async () => {
    const argus = mockArgus({
      ...claimable,
      items: [
        { ...claimable.items[0], localTier: 'user' },
        { ...claimable.items[0], name: 'other.md', installed: false, localTier: null }
      ]
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-note.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /as mine/ })).not.toBeInTheDocument()
  })

  it('a rejected claim surfaces in the alert banner', async () => {
    const argus = mockArgus(claimable)
    ;(argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference = vi
      .fn()
      .mockRejectedValue(new Error('claim exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.mocked(confirm).mockResolvedValue(true)
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/claim exploded/)
  })
})

describe('update hazards', () => {
  it('warns that a forked skill will keep shadowing after the update', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: ready.items.map((i) => (i.name === 'hive-probe' ? { ...i, shadowedByUser: true } : i))
    }
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-probe'))
    expect(await screen.findByText(/after this update:.*keep being used/i)).toBeInTheDocument()
    // kind gate: divergence is a reference-only concept — skills must never probe it.
    expect(localDivergenceMock).not.toHaveBeenCalled()
  })

  it('shows the local-vs-incoming diff and relabels the button when a reference diverged', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'hive-note.md',
          description: '',
          commit: 'sha-3',
          installed: true,
          installedCommit: 'sha-2',
          localTier: 'user',
          shadowedByUser: false,
          author: null,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({
      diverged: true,
      diff: 'diff --git a/mine/hive-note.md b/incoming/hive-note.md\n@@ -1,2 +1,1 @@\n-MY UNPUSHED PARAGRAPH\n',
      tierChange: null
    })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-note.md'))
    expect(
      await screen.findByText(/differs from the version that would be installed/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Overwrite my copy of hive-note.md')).toBeInTheDocument()
  })

  it('passes the acknowledgement flag when the user confirms the overwrite', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'hive-note.md',
          description: '',
          commit: 'sha-3',
          installed: true,
          installedCommit: 'sha-2',
          localTier: 'user',
          shadowedByUser: false,
          author: null,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({
      diverged: true,
      diff: 'diff --git a/x b/x\n',
      tierChange: null
    })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-note.md'))
    fireEvent.click(await screen.findByLabelText('Overwrite my copy of hive-note.md'))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith('reference', 'hive-note.md', {
        overwriteLocalEdits: true
      })
    )
  })

  it('a diverged reference with no divergence diff (fail-closed) still warns and relabels, but renders no divergence diff block', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'hive-note.md',
          description: '',
          commit: 'sha-3',
          installed: true,
          installedCommit: 'sha-2',
          localTier: 'user',
          shadowedByUser: false,
          author: null,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({ diverged: true, diff: '', tierChange: null })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-note.md'))
    expect(
      await screen.findByText(/differs from the version that would be installed/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Overwrite my copy of hive-note.md')).toBeInTheDocument()
    // cheapest stable handle for "no divergence diff block rendered": its caption must be absent.
    expect(screen.queryByText(/Your edits — would be lost/i)).not.toBeInTheDocument()
  })

  it('the divergence banner and its confirm button carry a danger tone, not the neutral shadow-warning chrome', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'hive-note.md',
          description: '',
          commit: 'sha-3',
          installed: true,
          installedCommit: 'sha-2',
          localTier: 'user',
          shadowedByUser: false,
          author: null,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({
      diverged: true,
      diff: 'diff --git a/x b/x\n',
      tierChange: null
    })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-note.md'))
    const banner = await screen.findByText(/differs from the version that would be installed/i)
    expect(banner.className).toMatch(/border-danger/)
    expect(banner.className).not.toMatch(/border-hair/)
    const button = screen.getByLabelText('Overwrite my copy of hive-note.md')
    expect(button.className).toMatch(/bg-danger/)
  })

  it('states a tier restamp even when the content has not diverged', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'confluence/hive-note.md',
          description: '',
          commit: 'sha-3',
          author: null,
          installed: true,
          installedCommit: 'sha-2',
          localTier: 'user',
          shadowedByUser: false,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({
      diverged: false,
      diff: '',
      tierChange: { from: 'user', to: 'confluence' }
    })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update confluence/hive-note.md'))
    // the tier names sit in nested <span>s, so a single-node getByText can't span them —
    // anchor on the direct text ("tier from") and assert on the line's full textContent instead.
    const tierLine = await screen.findByText(/tier from/i)
    expect(tierLine).toHaveTextContent(/user.*confluence/i)
    expect(tierLine).toHaveTextContent(/share/i)
    // not diverged: no overwrite gate, ordinary re-download
    expect(screen.getByLabelText('Re-download confluence/hive-note.md')).toBeInTheDocument()
  })

  it('renders "none" rather than a blank gap when the local file has no readable tier', async () => {
    // A local file with no readable frontmatter yields an empty `from` — referenceTier()
    // returns '' for a tier-less/absent block, not a HivemindItem-shaped value.
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'reference',
          name: 'hive-note.md',
          description: '',
          commit: 'sha-3',
          author: null,
          installed: true,
          installedCommit: 'sha-2',
          localTier: null,
          shadowedByUser: false,
          updateAvailable: true,
          orphaned: false,
          declined: false
        }
      ]
    }
    localDivergenceMock.mockResolvedValue({
      diverged: false,
      diff: '',
      tierChange: { from: '', to: 'hivemind' }
    })
    renderWith(payload)
    fireEvent.click(await screen.findByLabelText('Update hive-note.md'))
    const tierLine = await screen.findByText(/tier from/i)
    expect(tierLine).toHaveTextContent(/none.*hivemind/i)
  })
})

describe('HivemindSettings byline', () => {
  it('names the contributor on an installable item', async () => {
    const argus = mockArgus({
      ...ready,
      items: [
        {
          ...ready.items[0],
          name: 'their-skill',
          description: 'does a thing',
          author: 'Alex Chen <alex@example.test>'
        }
      ]
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText(/by Alex Chen/)).toBeInTheDocument()
  })

  it('shows no byline for an unauthored item', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const row = await screen.findByText('hive-probe')
    // Structural check, not a text-substring guess: withByline only ever emits the "by <name>"
    // fragment inside a lone `text-mute` span (see byline.tsx); the description wrapper SettingRow
    // renders around it is `text-xs text-mute` (two classes), so this selector can't collide with
    // a description that happens to contain the word "by" (e.g. "written by hand", "lobby").
    expect(row.closest('div')?.querySelector('span[class="text-mute"]')).toBeNull()
  })

  it('renders no description line for an item with neither description nor author', async () => {
    // hive-note.md has description: '' and author: null — the untested cell of the 2x2 matrix.
    // withByline('', null) must return `undefined` (not '' or an empty node) so SettingRow's
    // `{description && <span>...}` guard skips rendering the description line entirely, matching
    // pre-withByline behavior exactly.
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const row = await screen.findByText('hive-note.md')
    expect(row.closest('div')?.querySelector('span.text-xs.text-mute')).toBeNull()
  })
})

describe('download hazards', () => {
  it('warns before downloading a skill you have already forked', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'skill',
          name: 'hive-probe',
          description: 'probe skill',
          commit: 'sha-2',
          author: null,
          installed: false,
          installedCommit: null,
          localTier: null,
          shadowedByUser: true,
          updateAvailable: false,
          orphaned: false,
          declined: false
        }
      ]
    }
    renderWith(payload)
    expect(await screen.findByLabelText('Download hive-probe')).toBeInTheDocument()
    expect(screen.getByText(/keep being used/i)).toBeInTheDocument()
  })

  it('does not warn when there is no fork', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'skill',
          name: 'hive-probe',
          description: 'probe skill',
          commit: 'sha-2',
          author: null,
          installed: false,
          installedCommit: null,
          localTier: null,
          shadowedByUser: false,
          updateAvailable: false,
          orphaned: false,
          declined: false
        }
      ]
    }
    renderWith(payload)
    expect(await screen.findByLabelText('Download hive-probe')).toBeInTheDocument()
    expect(screen.queryByText(/keep being used/i)).not.toBeInTheDocument()
  })

  // Neither test above exercises the `!installed` half of the render guard — both use
  // installed: false. An already-installed, up-to-date fork (no Update button either, since
  // there's no pending update) must not show the row-level banner: that case is covered by
  // the update panel itself, not the Download path.
  it('does not warn on an already-installed fork with no update pending', async () => {
    const payload: HivemindPayload = {
      ...ready,
      items: [
        {
          kind: 'skill',
          name: 'hive-probe',
          description: 'probe skill',
          commit: 'sha-2',
          author: null,
          installed: true,
          installedCommit: 'sha-2',
          localTier: null,
          shadowedByUser: true,
          updateAvailable: false,
          orphaned: false,
          declined: false
        }
      ]
    }
    renderWith(payload)
    expect(await screen.findByRole('button', { name: 'Remove hive-probe' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Download hive-probe')).not.toBeInTheDocument()
    expect(screen.queryByText(/keep being used/i)).not.toBeInTheDocument()
  })
})

describe('auto-sync on entering the Team tab', () => {
  // Task 13: the auto-sync effect now goes through the currency service's rate limiter
  // (surveyNow('hive')) instead of calling hivemind.sync() directly, then re-reads via
  // hivemind.get(). The explicit Sync IconBtn is covered directly below — it still calls
  // hivemind.sync() and is never routed through surveyNow.
  it('syncs automatically once the reachability check succeeds, with no Sync click', async () => {
    renderWith(ready)
    await waitFor(() => expect(window.argus.currency.surveyNow).toHaveBeenCalledWith('hive'))
    expect(window.argus.currency.surveyNow).toHaveBeenCalledTimes(1)
    expect(window.argus.hivemind.sync).not.toHaveBeenCalled()
  })

  // Finding 1 (superseded by Task 8): this used to assert the manual Sync button called
  // `hivemind.sync()` directly — the very defect Task 8 fixes. The button is now routed
  // through a forced `currency.surveyNow('hive', true)`, mirroring Packs' "Check for updates"
  // button, because the hive adapter's `survey()` performs the sync itself and then re-derives
  // `currency.blocked`; a direct `hivemind.sync()` call alongside it would sync the repo twice
  // per click. The two tests below replace this one and close the same coverage gap (nothing
  // else in this suite clicks the manual Sync button) against the new, correct behavior.
  it('routes the Sync button through a forced currency survey', async () => {
    renderHive({ items: [item({ kind: 'skill', name: 'a' })] })
    await userEvent.click(await screen.findByLabelText('Sync'))
    await waitFor(() => expect(surveyNowMock).toHaveBeenCalledWith('hive', true))
  })

  it('does not call hivemind.sync directly — the survey performs it', async () => {
    renderHive({ items: [item({ kind: 'skill', name: 'a' })] })
    const syncMock = window.argus.hivemind.sync as ReturnType<typeof vi.fn>
    syncMock.mockClear()
    await userEvent.click(await screen.findByLabelText('Sync'))
    await waitFor(() => expect(surveyNowMock).toHaveBeenCalledWith('hive', true))
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('skips auto-sync when the repo is not reachable', async () => {
    window.argus.hivemind.check = vi.fn().mockResolvedValue({ ok: false, error: 'no access' })
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('not reachable')).toBeInTheDocument()
    expect(window.argus.currency.surveyNow).not.toHaveBeenCalled()
  })

  it('does not lock the panel while auto-syncing in the background', async () => {
    const argus = mockArgus(ready)
    let resolveSurvey: (() => void) | undefined
    ;(argus.currency as { surveyNow: ReturnType<typeof vi.fn> }).surveyNow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSurvey = resolve
        })
    )
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const downloadBtn = await screen.findByLabelText('Download hive-note.md')
    expect(downloadBtn).not.toBeDisabled()
    resolveSurvey?.()
  })
})

describe('download all', () => {
  const multiSkills: HivemindPayload = {
    ...ready,
    items: [
      {
        ...ready.items[0],
        name: 'skill-a',
        installed: false,
        updateAvailable: false,
        installedCommit: null
      },
      {
        ...ready.items[0],
        name: 'skill-b',
        installed: false,
        updateAvailable: false,
        installedCommit: null
      },
      { ...ready.items[0], name: 'skill-c', installed: true, updateAvailable: false },
      ready.items[1] // uninstalled reference, unaffected by the Skills button
    ]
  }

  it('downloads every not-yet-installed skill and omits already-installed ones', async () => {
    renderWith(multiSkills)
    fireEvent.click(await screen.findByRole('button', { name: 'Download all skills' }))
    await waitFor(() => expect(installMock).toHaveBeenCalledWith('skill', 'skill-a'))
    await waitFor(() => expect(installMock).toHaveBeenCalledWith('skill', 'skill-b'))
    expect(installMock).not.toHaveBeenCalledWith('skill', 'skill-c')
  })

  it('hides Download All when nothing in that section is downloadable', async () => {
    const allInstalled: HivemindPayload = {
      ...ready,
      items: [{ ...ready.items[0], installed: true, updateAvailable: false }]
    }
    renderWith(allInstalled)
    await screen.findByText('hive-probe')
    expect(screen.queryByRole('button', { name: 'Download all skills' })).not.toBeInTheDocument()
  })

  it('continues past a failed item and reports the failures together', async () => {
    const argus = mockArgus(multiSkills)
    ;(argus.hivemind as { install: ReturnType<typeof vi.fn> }).install = vi
      .fn()
      .mockImplementation((_kind: string, name: string) =>
        name === 'skill-a' ? Promise.reject(new Error('boom')) : Promise.resolve(multiSkills)
      )
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download all skills' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Failed to download: skill-a/)
    expect((argus.hivemind as { install: ReturnType<typeof vi.fn> }).install).toHaveBeenCalledWith(
      'skill',
      'skill-b'
    )
  })
})

describe('held-back items', () => {
  it('chips an orphaned item', async () => {
    renderHive({ items: [item({ name: 'gone', orphaned: true, installed: true })] })
    expect(await screen.findByText('not in hive')).toBeInTheDocument()
  })

  it('chips a tombstoned item and still offers Download as the undo', async () => {
    renderHive({ items: [item({ name: 'removed', installed: false, declined: true })] })
    expect(await screen.findByText('not mirrored')).toBeInTheDocument()
    expect(screen.getByLabelText('Download removed')).toBeInTheDocument()
  })

  it('does not chip an ordinary not-installed item', async () => {
    renderHive({ items: [item({ name: 'fresh', installed: false, declined: false })] })
    await screen.findByLabelText('Download fresh')
    expect(screen.queryByText('not mirrored')).not.toBeInTheDocument()
  })

  it('shows the held-back reason under a hive item', async () => {
    renderHive({
      items: [item({ kind: 'reference', name: 'style.md', localTier: 'hivemind' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-reference',
            key: 'reference/style.md',
            label: 'style.md',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    expect(
      await screen.findByText(/held back — you have edited this locally\./i)
    ).toBeInTheDocument()
  })

  it('badges the HiveMind section with the held-back count', async () => {
    renderHive({
      items: [item({ kind: 'reference', name: 'style.md' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/a',
            label: 'a',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'tier-change', from: 'mine', to: 'hivemind' }
          }
        ],
        busy: false
      }
    })
    expect(await screen.findByLabelText('1 HiveMind update needs you')).toBeInTheDocument()
  })

  it('pluralizes both the noun and the verb in the badge label for more than one held-back item in the same section', async () => {
    // Both candidates are 'hive-skill', so this exercises the Skills badge's own plural
    // grammar — not a combined cross-section total (badges are per-section since Fix wave 1;
    // see 'badges References but not Skills' below for the domain split itself).
    renderHive({
      items: [item({ kind: 'skill', name: 'a' }), item({ kind: 'skill', name: 'c' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/a',
            label: 'a',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'auth' }
          },
          {
            domain: 'hive-skill',
            key: 'skill/c',
            label: 'c',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    expect(await screen.findByLabelText('2 HiveMind updates need you')).toBeInTheDocument()
    // No reference item and no hive-reference candidate — References never renders, so the
    // label found above can only be the Skills section's own badge.
    expect(screen.queryByText('References')).not.toBeInTheDocument()
  })

  /**
   * The test that makes the per-section split load-bearing (Fix wave 1). Both sections are
   * forced to actually render (one skill item, one reference item) so there is somewhere for a
   * wrongly-placed badge to land: a combined-list implementation (both sections reading the same
   * `blockedHive` total instead of their own domain slice) would badge Skills too and this test
   * would catch it, even though every other test in this file — including the single-candidate
   * 'badges the HiveMind section' test above — stays green under that same bug, since none of
   * them render a second, badge-less section to check against.
   */
  it('badges References but not Skills for a single hive-reference block, with both sections visible', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'a' }), item({ kind: 'reference', name: 'style.md' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-reference',
            key: 'reference/style.md',
            label: 'style.md',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    const referencesSection = (await screen.findByText('References')).closest('section')!
    expect(
      within(referencesSection).getByLabelText('1 HiveMind update needs you')
    ).toBeInTheDocument()

    const skillsSection = screen.getByText('Skills').closest('section')!
    expect(within(skillsSection).queryByLabelText(/HiveMind update.*need/i)).not.toBeInTheDocument()
  })

  it('shows no section badge when nothing is held back', async () => {
    renderHive({
      currency: { auto: true, lastSurveyAt: new Date().toISOString(), blocked: [], busy: false }
    })
    await screen.findByText('hive-probe')
    expect(screen.queryByLabelText(/needs you|need you/i)).not.toBeInTheDocument()
  })

  it('says so when a filter hides the held-back row', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'triage' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/triage',
            label: 'triage',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    await screen.findByLabelText('1 HiveMind update needs you')
    await userEvent.type(screen.getByLabelText('Filter HiveMind content'), 'zzz')
    expect(await screen.findByText('1 held-back item is not shown here.')).toBeInTheDocument()
  })

  it('says nothing when the held-back row is visible', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'triage' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/triage',
            label: 'triage',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    await screen.findByLabelText('1 HiveMind update needs you')
    expect(screen.queryByText(/not shown here/i)).not.toBeInTheDocument()
  })

  // Fix wave 1: the two tests above only ever drove `unshownSkills`/`unshownReferences` at zero,
  // or routed through the OUTER filter-matches-nothing ternary (a different expression entirely,
  // `blockedSkills.length + blockedReferences.length` at :678) — so the per-section counts at
  // HivemindSettings.tsx:597-598, rendered at :691 and :723, were never proven against a nonzero
  // value. These three close that gap.

  it('says so within the Skills section for a blocked skill with no visible row, without a filter', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'visible-skill' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/other',
            label: 'other',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    // No filter is typed, so `skills.length === 1` keeps the outer ternary from ever firing —
    // this can only be the per-section UnshownHoldsLine at :691, driven by `unshownSkills`.
    const skillsSection = (await screen.findByText('Skills')).closest('section')!
    expect(
      within(skillsSection).getByText('1 held-back item is not shown here.')
    ).toBeInTheDocument()
  })

  it('says so within the References section for a blocked reference with no visible row', async () => {
    renderHive({
      items: [item({ kind: 'reference', name: 'visible-ref.md' })],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-reference',
            key: 'reference/other.md',
            label: 'other.md',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    const referencesSection = (await screen.findByText('References')).closest('section')!
    expect(
      within(referencesSection).getByText('1 held-back item is not shown here.')
    ).toBeInTheDocument()
  })

  it('does not leak an unshown-skill count into the References section', async () => {
    // Both sections visible (one real row each), so an implementation that fed both sections the
    // combined `blockedSkills.length + blockedReferences.length` instead of their own domain
    // slice would show the line in References too — this is what catches that.
    renderHive({
      items: [
        item({ kind: 'skill', name: 'visible-skill' }),
        item({ kind: 'reference', name: 'visible-ref.md' })
      ],
      currency: {
        auto: true,
        lastSurveyAt: new Date().toISOString(),
        blocked: [
          {
            domain: 'hive-skill',
            key: 'skill/other',
            label: 'other',
            from: 'x',
            to: 'y',
            verdict: 'blocked',
            reason: { kind: 'local-edits' }
          }
        ],
        busy: false
      }
    })
    const skillsSection = (await screen.findByText('Skills')).closest('section')!
    expect(
      within(skillsSection).getByText('1 held-back item is not shown here.')
    ).toBeInTheDocument()
    const referencesSection = screen.getByText('References').closest('section')!
    expect(within(referencesSection).queryByText(/not shown here/i)).not.toBeInTheDocument()
  })
})

describe('download all honours tombstones', () => {
  it('leaves a tombstoned item alone when downloading all', async () => {
    renderHive({
      items: [
        item({ kind: 'skill', name: 'kept', installed: false, declined: false }),
        item({ kind: 'skill', name: 'removed', installed: false, declined: true })
      ]
    })
    await userEvent.click(await screen.findByLabelText('Download all skills'))
    await waitFor(() => expect(installMock).toHaveBeenCalledWith('skill', 'kept'))
    // `downloadAll` is a SEQUENTIAL loop: at the instant 'kept' is first observed, the second
    // iteration (which would process 'removed', if the `!it.declined` filter were deleted) has
    // not run yet — so `.not.toHaveBeenCalledWith('skill', 'removed')` alone can pass whether or
    // not the tombstone filter exists, purely on timing. Waiting for the progress indicator to
    // clear (the loop's own signal that every iteration, not just the first, has finished) before
    // checking the call count is what actually pins the filter.
    await waitFor(() => expect(screen.queryByText(/Downloading…/)).not.toBeInTheDocument())
    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).not.toHaveBeenCalledWith('skill', 'removed')
  })

  it('still offers the per-item Download as the tombstone undo', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'removed', installed: false, declined: true })]
    })
    await userEvent.click(await screen.findByLabelText('Download removed'))
    await waitFor(() => expect(installMock).toHaveBeenCalledWith('skill', 'removed'))
  })

  it('hides Download All when every candidate is tombstoned', async () => {
    renderHive({
      items: [item({ kind: 'skill', name: 'removed', installed: false, declined: true })]
    })
    await screen.findByLabelText('Download removed')
    expect(screen.queryByLabelText('Download all skills')).not.toBeInTheDocument()
  })
})

// Important (fix-wave review of 84b09df0): `payload.error` describes the CLONE's state (a
// possibly-stale `lastSyncError`), not the outcome of whichever call returned it. Only the Sync
// button is actually attempting a sync, so only it may turn `payload.error` into an alert banner
// — the mount effect and every write (install/uninstall/reinstall/downloadAll) must not.
describe('a persisted sync error does not leak into unrelated operations', () => {
  // Same shape as `ready` (state 'error', non-empty items) as the Critical fix in this same wave
  // now returns: the clone is still readable, so the page still has items, but a past sync failed.
  const staleError: HivemindPayload = { ...ready, state: 'error', error: 'divergent history' }

  it('does not raise an alert on mount just because a past sync failed', async () => {
    renderWith(staleError)
    // Wait for the page to actually finish loading this payload before asserting an absence —
    // otherwise the assertion could pass on a still-loading first frame regardless of the fix.
    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not raise an alert for a successful Download even though the payload carries a stale sync error', async () => {
    renderWith(ready)
    // AFTER renderWith: `mockArgus()` itself does `installMock.mockResolvedValue(payload)`, so
    // setting this before render would just be clobbered back to `ready` (no error) by render.
    installMock.mockResolvedValue(staleError)
    await userEvent.click(await screen.findByLabelText('Download hive-note.md'))
    // Waiting merely for `installMock` to have been *called* races `run()`'s own state updates —
    // the mock resolves synchronously, so that wait can (and, against the pre-fix code, does)
    // resolve before setPayload/setError land. The status chip flipping to 'error' is set from
    // the same `setPayload(p)` call any `setError` would follow, in the same synchronous tail —
    // so it is a completion signal that (unlike the Download button) survives even if the
    // returned payload's item list makes the button itself disappear.
    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not raise an alert for a successful Download All even though the payload carries a stale sync error', async () => {
    renderHive({ items: [item({ kind: 'skill', name: 'a', installed: false })] })
    // AFTER renderHive/mockArgus, for the same reason as the single-Download test above.
    installMock.mockResolvedValue(staleError)
    await userEvent.click(await screen.findByLabelText('Download all skills'))
    // Same race as the single-Download case above, and the same completion signal: the status
    // chip flips to 'error' in the same tick as any `setError` from the loop's `install()` call,
    // and unlike the Download All button itself, it does not depend on the returned payload's
    // item list still containing a downloadable skill.
    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // The flip side: this is NOT a blanket suppression. The Sync button is genuinely attempting a
  // sync, so a clone-state error is this call's own outcome and must still surface.
  it('still raises an alert when the Sync button itself lands a persisted error', async () => {
    const argus = mockArgus(ready) as unknown as { hivemind: { get: ReturnType<typeof vi.fn> } }
    argus.hivemind.get = vi.fn().mockResolvedValue(staleError)
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await userEvent.click(await screen.findByLabelText('Sync'))
    expect(await screen.findByRole('alert')).toHaveTextContent('divergent history')
  })
})
