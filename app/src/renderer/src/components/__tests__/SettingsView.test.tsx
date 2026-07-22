// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { SettingsView } from '../settings/SettingsView'
import { SetupWizard } from '../onboarding/SetupWizard'
import { settingsStore } from '../../lib/settingsStore'
import { proposalsStore } from '../../lib/proposalsStore'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import { connectorsStore } from '../../lib/connectorsStore'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import { DEFAULT_PRESETS } from '../../../../shared/connectors'
import type { PacksListPayload } from '../../../../shared/packs'
import type { RefSyncPayload } from '../../../../shared/referenceSync'

function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [
      {
        id: 'sample-parse',
        packId: 'sample-pack',
        displayName: 'sample-parse binary',
        description: 'Binary log decoder',
        kind: 'exe',
        envVar: 'ARGUS_PARSE_BIN',
        settingsKey: 'parseBin',
        settingsValue: '',
        value: null,
        source: 'default'
      }
    ],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null,
    ...overrides
  }
}

const packsListed: PacksListPayload = {
  error: null,
  packs: [
    {
      id: 'navigation',
      displayName: 'Navigation',
      installedVersion: '1.0.0',
      loadedVersion: '1.0.0',
      platform: 'win-x64',
      pendingRelaunch: false,
      binaries: []
    }
  ]
}

const refPayload: RefSyncPayload = {
  config: { spaces: [], outdatedWindowMonths: 12, mustKeep: {} },
  loadError: null,
  cards: [],
  references: []
}

let currentPayload: SettingsPayload

beforeEach(() => {
  currentPayload = payload()
  // SettingsStore is a lazy-started module singleton (Task 8); reset it so each
  // test's fresh <SettingsView/> mount refetches against this test's mocked payload
  // instead of reusing whatever an earlier test in this file already cached.
  settingsStore.reset()
  // Same story for the proposals badge count store — reset so each test's mount
  // refetches against this test's mocked proposals.list instead of reusing an
  // earlier test's cached count.
  proposalsStore.reset()
  // Library/Sources now mount as ordinary pages (Task 7), so their backing stores
  // need the same fresh-mount treatment as settings/proposals above.
  referenceSyncStore.reset()
  connectorsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => currentPayload),
      patch: vi.fn(async () => currentPayload),
      probeTools: vi.fn(async () => []),
      pickPath: vi.fn(async () => null),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    packs: {
      list: vi.fn(async () => packsListed),
      pickBundle: vi.fn(async () => null),
      inspect: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
      relaunch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })) },
    connectors: {
      get: vi.fn(async () => ({
        connectors: {},
        runtime: {},
        oauth: {},
        loadError: null,
        secretsAvailable: true,
        secretsLoadError: null,
        presets: DEFAULT_PRESETS
      })),
      patch: vi.fn(async () => ({
        connectors: {},
        runtime: {},
        oauth: {},
        loadError: null,
        secretsAvailable: true,
        secretsLoadError: null,
        presets: DEFAULT_PRESETS
      })),
      test: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      oauth: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn(() => () => {})
    },
    secrets: {
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    health: {
      list: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
      onResult: vi.fn(() => () => {})
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: 'gh version 2.96.0 (2026-07-02)',
        authenticated: true,
        login: 'jiawiehan',
        detail: 'Logged in to github.com account jiawiehan'
      })
    },
    proposals: {
      list: vi.fn(async () => ({ proposals: [] })),
      onChanged: vi.fn(() => () => {})
    },
    skills: {
      list: vi.fn(async () => ({ skills: [] })),
      deleteUser: vi.fn()
    },
    usage: {
      stats: vi.fn(async () => ({ hygiene: null, skills: [], references: [] }))
    },
    refsync: {
      get: vi.fn(async () => refPayload),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
      sync: vi.fn(async () => ({ ok: false, code: 'auth', message: 'PAT rejected' })),
      removeSpace: vi.fn(async () => refPayload),
      searchRefs: vi.fn(async () => []),
      readRef: vi.fn(async () => ({ file: 'glossary.md', content: '# Glossary\n' }))
    },
    hivemind: {
      get: vi.fn(async () => ({
        repo: '',
        state: 'dormant',
        error: null,
        headCommit: null,
        lastSynced: null,
        items: [],
        pushable: [],
        pushes: {}
      })),
      check: vi.fn(async () => ({ ok: true }))
    }
  } as never
})

afterEach(() => __resetEscapeLayersForTest())

describe('SettingsView', () => {
  it('renders the rail: 8 active pages, 0 coming-soon entries', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    for (const label of [
      'General',
      'Agent',
      'Health',
      'Connectors',
      'Library',
      'Team',
      'Memory',
      'Observability'
    ])
      expect(
        (screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled
      ).toBe(false)
  })

  it('lists sections in the intended order and drops Analysis Tools', () => {
    render(<SettingsView onClose={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const labels = Array.from(nav.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(labels).toEqual([
      'General',
      'Agent',
      'Connectors',
      'Proposals',
      'Library',
      'Memory',
      'Team',
      'Sources',
      'Health',
      'Observability'
    ])
    expect(screen.queryByText('Analysis Tools')).toBeNull()
  })

  it('sidebar renders three labeled groups', () => {
    render(<SettingsView onClose={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    for (const g of ['App', 'Knowledge', 'System']) expect(nav).toHaveTextContent(g)
  })

  it('falls back to General for an unrecognised initialPage', () => {
    // OnboardingProvider deep-links via `target as PageId`, so a stale 'tools'
    // target is a runtime value the type system never sees.
    render(<SettingsView onClose={() => {}} initialPage={'tools' as never} />)
    const general = screen
      .getByRole('navigation', { name: 'Settings sections' })
      .querySelector('button')
    expect(general?.className).toContain('bg-hi')
  })

  it('clicking Health renders the health page', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /^Health$/ }))
    expect(await screen.findByText('Health checks')).toBeTruthy()
  })

  it('clicking Connectors renders the connectors page', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /Connectors/ }))
    expect(await screen.findByRole('button', { name: /add connector/i })).toBeTruthy()
  })

  it('clicking Sources renders SourcesPage', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /^Sources$/ }))
    expect(await screen.findByText('Installed Packs')).toBeTruthy()
    expect(await screen.findByText('Navigation')).toBeTruthy()
  })

  it('Escape calls onClose', async () => {
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape does not close settings while the setup wizard is open above it', async () => {
    const onClose = vi.fn()
    // Mount order mirrors production: SettingsView mounts first, then the
    // wizard is opened over it via "rerun setup".
    render(
      <>
        <SettingsView onClose={onClose} />
        <SetupWizard onComplete={vi.fn()} onDismiss={vi.fn()} />
      </>
    )
    await screen.findByRole('button', { name: /General/ })
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape closes settings when no wizard is open', async () => {
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape on a focused SelectField blurs it instead of being swallowed', async () => {
    // Focus remains on a <select> after choosing an option, and the shared
    // escape-layer dispatcher deliberately ignores Escape targeting a focused
    // field (the field is supposed to own that keystroke) — so an unhandled
    // select would trap Escape forever on whatever page it's on. SelectField
    // must blur itself on Escape so the *next* Escape reaches the layer.
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    const themeSelect = screen.getByRole('combobox', { name: 'Theme' })
    themeSelect.focus()
    expect(document.activeElement).toBe(themeSelect)
    fireEvent.keyDown(themeSelect, { key: 'Escape' })
    expect(document.activeElement).not.toBe(themeSelect)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a load-error banner with an Open file action', async () => {
    currentPayload = payload({ loadError: 'Unexpected token' })
    render(<SettingsView onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('could not be parsed')
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(window.argus.settings.reveal).toHaveBeenCalledWith('settingsFile')
  })

  it('a save-failure loadError renders its own message, not the parse-failure copy', async () => {
    currentPayload = payload({ loadError: 'settings save failed: EACCES' })
    render(<SettingsView onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText(/could not be parsed/)).toBeNull()
    expect(alert.textContent).toContain('settings save failed: EACCES')
  })

  it('sidebar shows Proposals with a pending-count badge', async () => {
    window.argus.proposals = {
      list: vi.fn(async () => ({ proposals: [{ type: 'skill-new' }, { type: 'recipe' }] })),
      onChanged: vi.fn(() => () => {})
    } as never
    render(<SettingsView onClose={vi.fn()} />)
    const btn = await screen.findByRole('button', { name: /Proposals/ })
    await waitFor(() => expect(btn).toHaveTextContent('2'))
  })

  it('visiting Proposals via the sidebar after a banner preset clears the stale filter', async () => {
    // Regression: ProposalsPage seeded its chip-filter state from initialTypes in a
    // useState initializer only. Clicking the sidebar's own "Proposals" entry while
    // already on the (preset-filtered) Proposals page called setProposalTypes(undefined)
    // without remounting the page, so the stale filter chip stayed pressed. The fix keys
    // <ProposalsPage> on the preset so a changed preset forces a remount.
    window.argus.proposals = {
      list: vi.fn(async () => ({
        proposals: [
          {
            file: 'p1.json',
            caseSlug: 'case-1',
            date: '2026-07-20T00:00:00.000Z',
            type: 'skill-new',
            target: 'some-skill',
            title: 'New skill proposal',
            current: null,
            previouslyReviewed: false,
            content: 'content'
          }
        ]
      })),
      onChanged: vi.fn(() => () => {})
    } as never
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })

    // Go to Library and use the banner's "Review ->" to open Proposals pre-filtered.
    fireEvent.click(screen.getByRole('button', { name: /^Library$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Review/ }))

    const chip = await screen.findByRole('button', { name: 'Filter Skill · new' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    // Now click the sidebar's own Proposals entry while already on the Proposals page.
    // (The pending-count badge is aria-hidden, so the accessible name stays exactly "Proposals".
    // Scoped to the nav: the knowledge-flow strip on this same page also links to "Proposals".)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Proposals' }))

    const chipAfter = await screen.findByRole('button', { name: 'Filter Skill · new' })
    expect(chipAfter).toHaveAttribute('aria-pressed', 'false')
  })

  it("alias: initialPage 'skills' lands on Library filtered to skills", async () => {
    render(<SettingsView onClose={vi.fn()} initialPage={'skills'} />)
    const lib = await screen.findByRole('button', { name: 'Library' })
    expect(lib.className).toContain('bg-hi')
    expect(await screen.findByRole('button', { name: 'Filter kind · skill' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it("alias: initialPage 'references' lands on Library filtered to references", async () => {
    render(<SettingsView onClose={vi.fn()} initialPage={'references'} />)
    expect(await screen.findByRole('button', { name: 'Filter kind · reference' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it("alias: 'hivemind' → Team and 'packs' → Sources", async () => {
    const { unmount } = render(<SettingsView onClose={vi.fn()} initialPage={'hivemind'} />)
    expect((await screen.findByRole('button', { name: 'Team' })).className).toContain('bg-hi')
    unmount()
    render(<SettingsView onClose={vi.fn()} initialPage={'packs'} />)
    expect((await screen.findByRole('button', { name: 'Sources' })).className).toContain('bg-hi')
    expect(await screen.findByText('Installed Packs')).toBeInTheDocument()
  })

  it('a deep link arriving while Settings is already open switches the visible page', async () => {
    // App.tsx mounts <SettingsView initialPage={view.page}/> without a key, so a
    // deep link fired while Settings is open (onboarding "configure in Settings",
    // tour, gotoSettings) only changes the prop — the view must follow it.
    const onClose = vi.fn()
    const { rerender } = render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    rerender(<SettingsView onClose={onClose} initialPage={'health'} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Health$/ }).className).toContain('bg-hi')
    )
    expect(await screen.findByText('Health checks')).toBeInTheDocument()
  })

  it('a legacy-alias deep link while open lands on Library with the kind preset', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    rerender(<SettingsView onClose={onClose} initialPage={'skills'} />)
    // Scoped to the nav: the knowledge-flow strip on the Library page also says "Library".
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect((await within(nav).findByRole('button', { name: 'Library' })).className).toContain(
      'bg-hi'
    )
    expect(await screen.findByRole('button', { name: 'Filter kind · skill' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('knowledge strip shows on Library and Proposals and its terms navigate', async () => {
    render(<SettingsView onClose={vi.fn()} initialPage={'library'} />)
    await userEvent.click(await screen.findByRole('button', { name: 'share back to the team' }))
    expect((await screen.findByRole('button', { name: 'Team' })).className).toContain('bg-hi')
  })
})
