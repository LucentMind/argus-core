// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, type ReactNode } from 'react'
import { AmbientAnchorContext, useAmbientAnchors, useAmbientAnchorState } from '../ambientAnchors'
import { settingsBarStore } from '../settingsBarStore'
import { caseBarStore } from '../caseBarStore'
import { uiStore } from '../uiStore'
import { TopBar } from '../../components/TopBar'

/**
 * Coverage for the anchor slots' claim/release contract (see lib/ambientAnchors.ts).
 *
 * jsdom cannot see the WebGL canvas the anchors ultimately steer, but the plumbing that broke is
 * plain React state and refs, and it broke on COMMIT ORDER — which jsdom reproduces exactly,
 * because it is React's scheduler doing it, not the browser. The regression these tests exist for
 * shipped green through a suite that only ever checked "does the view attach a ref at all".
 */

beforeEach(() => {
  localStorage.clear()
  settingsBarStore.reset()
  caseBarStore.reset()
  uiStore.setDynamicTheme(false)
  window.argus = {
    modes: { available: vi.fn(async () => ['investigation', 'review']) },
    distill: { status: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
    cases: {
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 9 }))
    },
    bundle: { export: vi.fn(async () => ({ ok: true, fileCount: 1 })) },
    jira: { refreshCase: vi.fn(), openIssue: vi.fn() },
    platform: 'win32',
    window: {
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
      onMaximizedChanged: vi.fn(() => () => {})
    }
  } as never
})

/** What the slots hold after the last commit, captured from an effect rather than during render
 *  so it describes committed state. */
let seen: { light: HTMLElement | null; cutoff: HTMLElement | null } = { light: null, cutoff: null }

/**
 * App's shape, reduced to the parts the bug lived in: one owner of the anchor state, the real
 * `TopBar` (which claims the anchors while Settings is up), and a swappable view below it. The
 * two anchor writers are siblings, which is the whole hazard.
 */
function Harness({ view }: { view: 'home' | 'settings' }): React.JSX.Element {
  const { light, cutoff, anchors } = useAmbientAnchorState()
  useEffect(() => {
    seen = { light, cutoff }
  }, [light, cutoff])
  return (
    <AmbientAnchorContext.Provider value={anchors}>
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
      {view === 'home' ? <FakeHome /> : <FakeSettings />}
    </AmbientAnchorContext.Provider>
  )
}

/** Home's anchor wiring: the greeting is the light, the filter row is the cutoff. */
function FakeHome(): React.JSX.Element {
  const anchors = useAmbientAnchors()
  return (
    <div>
      <h1 data-testid="home-light" ref={anchors.setLight}>
        Good evening
      </h1>
      {/* eslint-disable-next-line react-hooks/refs */}
      <div data-testid="home-cutoff" ref={anchors.setCutoff}>
        filters
      </div>
    </div>
  )
}

/**
 * `SettingsView`'s store contract, and specifically its TIMING: the identity is published from a
 * mount effect and cleared from an unmount cleanup — both passive-phase, so `TopBar` learns that
 * Settings is gone one commit AFTER the view swap has already happened. Faked rather than the real
 * SettingsView because the whole IPC surface that view needs is irrelevant to the ordering; this
 * is a copy of the two lines that matter (SettingsView.tsx: publish on mount, publish(null) on
 * unmount).
 */
function FakeSettings(): React.JSX.Element {
  useEffect(() => {
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
  }, [])
  useEffect(() => () => settingsBarStore.publish(null), [])
  return <div>settings body</div>
}

describe('ambient anchor slots', () => {
  it('hands the anchors to TopBar while Settings is up', () => {
    render(<Harness view="settings" />)
    expect(seen.cutoff).toBe(screen.getByRole('banner'))
    expect(seen.light).toBe(screen.getByTestId('settings-title'))
  })

  it('leaving Settings does not clobber the destination view’s anchors', () => {
    // THE REGRESSION (2026-08-02). Home attaches its anchors in the commit that swaps the view;
    // TopBar drops its own one commit later, when SettingsView's passive cleanup clears
    // settingsBarStore. With last-write-wins slots that trailing detach wrote null over anchors
    // that already belonged to home, and the ambient canvas fell back to its hardcoded 460px
    // cutoff on every view reached from Settings.
    const { rerender } = render(<Harness view="settings" />)
    expect(seen.cutoff).toBe(screen.getByRole('banner'))

    rerender(<Harness view="home" />)

    expect(seen.cutoff).toBe(screen.getByTestId('home-cutoff'))
    expect(seen.light).toBe(screen.getByTestId('home-light'))
    // and TopBar really has let go — the assertion above would also pass if Settings were somehow
    // still up, which would mean the ordering was never exercised
    expect(screen.queryByTestId('settings-title')).toBeNull()
  })

  it('entering Settings hands the anchors over rather than leaving the old view’s', () => {
    // The other direction, where the release DOES matter: home's elements are gone, so the slots
    // must not keep pointing at detached nodes. Guards against "fix" the ownership check by never
    // releasing at all.
    const { rerender } = render(<Harness view="home" />)
    expect(seen.cutoff).toBe(screen.getByTestId('home-cutoff'))

    rerender(<Harness view="settings" />)

    expect(seen.cutoff).toBe(screen.getByRole('banner'))
    expect(seen.light).toBe(screen.getByTestId('settings-title'))
  })

  it('a departing writer releases only the node it claimed', () => {
    // The contract in isolation, without any view semantics: two writers, the second claims the
    // slot while the first is still mounted, then the first unmounts. Its release must be a no-op.
    function TwoWriters({ first }: { first: boolean }): React.JSX.Element {
      const anchors = useAmbientAnchors()
      return (
        <>
          {first && <div data-testid="first" ref={anchors.setCutoff} />}
          {/* eslint-disable-next-line react-hooks/refs */}
          <div data-testid="second" ref={anchors.setCutoff} />
        </>
      )
    }
    function Owner({ children }: { children: ReactNode }): React.JSX.Element {
      const { cutoff, anchors } = useAmbientAnchorState()
      useEffect(() => {
        seen = { light: null, cutoff }
      }, [cutoff])
      return (
        <AmbientAnchorContext.Provider value={anchors}>{children}</AmbientAnchorContext.Provider>
      )
    }

    const { rerender } = render(
      <Owner>
        <TwoWriters first />
      </Owner>
    )
    // Both attach in the same commit; the later element in tree order wins the slot.
    expect(seen.cutoff).toBe(screen.getByTestId('second'))

    rerender(
      <Owner>
        <TwoWriters first={false} />
      </Owner>
    )
    expect(seen.cutoff).toBe(screen.getByTestId('second'))
  })
})
