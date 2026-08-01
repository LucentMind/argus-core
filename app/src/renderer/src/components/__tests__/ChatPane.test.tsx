// @vitest-environment jsdom
import { render, screen, fireEvent, act, waitForElementToBeRemoved } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatPane } from '../ChatPane'
import { agentStore } from '../../lib/agentStore'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { composerAttachments } from '../../lib/composerAttachments'
import { defaultSettings } from '../../../../shared/settings'
import type { AgentEvent } from '../../../../shared/agent-events'

const base = {
  eventId: 'e',
  caseId: 1,
  caseSlug: 'NAV-1',
  sessionId: 1,
  turnId: 1,
  ts: '2026-07-09T00:00:00Z'
}
const ev = (type: string, payload: unknown): AgentEvent =>
  ({ ...base, type, payload }) as AgentEvent

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    agent: { send: vi.fn(), interrupt: vi.fn(), onEvent: vi.fn(() => () => undefined) },
    sessions: {
      list: vi.fn(async () => [
        { id: 1, title: '', turnCount: 0, updatedAt: '2026-07-09T00:00:00Z' }
      ]),
      create: vi.fn(async () => ({
        id: 2,
        title: '',
        turnCount: 0,
        updatedAt: '2026-07-09T00:00:00Z'
      })),
      rename: vi.fn(async () => undefined)
    },
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    evidence: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ChatPane', () => {
  it('renders transcript with citation chip and tool card', () => {
    agentStore.apply(ev('turn.started', { userText: 'why crash?' }))
    agentStore.apply(ev('assistant.message', { text: 'Crash at [evidence/log.txt:3]' }))
    agentStore.apply(
      ev('tool.call.started', { toolCallId: 't1', name: 'mcp__argus__search_evidence' })
    )
    const onCite = vi.fn()
    render(<ChatPane slug="NAV-1" sessionId={1} onSwitchSession={vi.fn()} onCite={onCite} />)
    expect(screen.getByText('why crash?')).toBeTruthy()
    // collapsed citation chip — clicking it only toggles expansion (which would
    // fetch a snippet via window.argus.evidence, unstubbed here); the
    // open-in-viewer -> onCite wiring is covered by CitationCard.test.tsx.
    const chip = screen.getByRole('button', { name: /log\.txt:3/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/search_evidence/)).toBeTruthy()
  })

  // Argus-composed turns (review run, apply, CI analyze prompts) render as markdown;
  // typed turns stay literal text. Mirrors CitedText.test.tsx's plain-text protection
  // (`3*4=12` must never be touched by a markdown/citation pass).
  it('renders a composed user turn as markdown', () => {
    const slug = 'NAV-COMPOSED'
    const at = (type: string, payload: unknown): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: '**Bold** turn', composed: true }))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    const strong = container.querySelector('strong')
    expect(strong).toBeTruthy()
    expect(strong?.textContent).toBe('Bold')
    expect(container.textContent).not.toContain('**Bold**')
  })

  it('keeps a plain typed user turn as literal text (no markdown, no field)', () => {
    const slug = 'NAV-PLAIN'
    const at = (type: string, payload: unknown): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: '3*4=12' }))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    expect(container.querySelector('strong')).toBeNull()
    expect(screen.getByText('3*4=12')).toBeTruthy()
  })

  it('hides tool cards when tool-call visibility is off, but keeps pending approvals', () => {
    const slug = 'NAV-TOGGLE'
    const at = (type: string, payload: unknown): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload }) as AgentEvent
    agentStore.apply(
      at('tool.call.started', { toolCallId: 't9', name: 'mcp__argus__read_evidence' })
    )
    agentStore.apply(
      at('request.opened', {
        requestId: 'r9',
        tool: 'Bash',
        risk: 'MEDIUM',
        grantKey: null,
        argsPreview: 'git push'
      })
    )
    uiStore.setShowToolCalls(false)
    try {
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
      expect(screen.queryByText(/read_evidence/)).toBeNull()
      expect(screen.getByText('git push')).toBeTruthy()
    } finally {
      uiStore.setShowToolCalls(true)
    }
  })

  it('sends composer text', () => {
    render(<ChatPane slug="NAV-1" sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
    const box = screen.getByPlaceholderText(/message the analyst/i)
    fireEvent.change(box, { target: { value: 'run /analyze-applog' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(window.argus.agent.send).toHaveBeenCalledWith('NAV-1', 1, 'run /analyze-applog')
  })

  // Minor review finding: composerAttachments.clear was uncovered — a
  // regression here (e.g. dropping the call on send) would leave stale
  // attachment chips from a previous message sitting in the tray.
  it('clears staged composer attachments on send', () => {
    const slug = 'NAV-CLEAR'
    composerAttachments.add(slug, 1, { id: 'a', name: 'shot.png', status: 'ready' })
    const clearSpy = vi.spyOn(composerAttachments, 'clear')
    render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
    const box = screen.getByPlaceholderText(/message the analyst/i)
    fireEvent.change(box, { target: { value: 'see attached' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(clearSpy).toHaveBeenCalledWith(slug, 1)
    expect(composerAttachments.get(slug, 1)).toHaveLength(0)
    clearSpy.mockRestore()
  })

  it('renders a data-turn-id anchor on user turns for jump-to-turn', () => {
    const slug = 'NAV-ANCHOR'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'anchor me' }, 10))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    expect(container.querySelector('[data-turn-id="10"]')).toBeTruthy()
  })

  // Regression: a chat-search hit on ASSISTANT text must land on the matched
  // assistant message, not on the turn's user message. In single-turn chats
  // (slash-command investigations) the turn's user message IS the first
  // message of the chat, so the old turn-anchored jump scrolled to the top
  // and flashed message #1 even for text at the very end of the transcript.
  it('jump to an assistant hit scrolls to and flashes the matched assistant message', () => {
    const slug = 'NAV-JUMP-A'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'run the pipeline' }, 7))
    agentStore.apply(at('assistant.message', { text: 'step one: parsing the log' }, 7))
    agentStore.apply(at('assistant.message', { text: 'step two: correlating spans' }, 7))
    agentStore.apply(
      at('assistant.message', { text: 'summary: root cause was a stale tile cache' }, 7)
    )
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const onFocusConsumed = vi.fn()
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{
          turnId: 7,
          role: 'assistant',
          snippet: '…root cause was a «stale» tile cache'
        }}
        onFocusConsumed={onFocusConsumed}
      />
    )
    // the matched assistant message is item index 3 (user, a1, a2, a3)
    const target = container.querySelector('[data-item-index="3"]')!
    expect(scrolled[scrolled.length - 1]).toBe(target)
    expect(target.className).toContain('bg-signal/20')
    // and NOT the turn's user anchor
    expect(scrolled[scrolled.length - 1]).not.toBe(container.querySelector('[data-turn-id="7"]'))
    expect(onFocusConsumed).toHaveBeenCalled()
  })

  it('jump to a user hit still scrolls to and flashes the turn user message', () => {
    const slug = 'NAV-JUMP-U'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'first question' }, 1))
    agentStore.apply(at('assistant.message', { text: 'first answer' }, 1))
    agentStore.apply(at('turn.started', { userText: 'braking pressure follow-up' }, 2))
    agentStore.apply(at('assistant.message', { text: 'second answer' }, 2))
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{ turnId: 2, role: 'user', snippet: '«braking» pressure follow-up' }}
        onFocusConsumed={vi.fn()}
      />
    )
    expect(scrolled[scrolled.length - 1]).toBe(container.querySelector('[data-turn-id="2"]'))
    expect(scrolled[scrolled.length - 1]?.className).toContain('bg-signal/20')
  })

  // the anchor may only appear after the target session's history hydrates —
  // the jump must then still resolve, scroll, and flash
  it('jump waits for hydration: scrolls once the matched message appears', () => {
    const slug = 'NAV-JUMP-H'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const onFocusConsumed = vi.fn()
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{ turnId: 9, role: 'assistant', snippet: 'ends with «frobnitz»' }}
        onFocusConsumed={onFocusConsumed}
      />
    )
    expect(onFocusConsumed).not.toHaveBeenCalled()
    act(() => {
      agentStore.hydrate(slug, 1, [
        at('turn.started', { userText: 'investigate' }, 9),
        at('assistant.message', { text: 'working on it' }, 9),
        at('assistant.message', { text: 'ends with frobnitz' }, 9)
      ] as AgentEvent[])
    })
    const target = container.querySelector('[data-item-index="2"]')!
    expect(scrolled[scrolled.length - 1]).toBe(target)
    expect(onFocusConsumed).toHaveBeenCalled()
  })

  // Opening a case/chat hydrates the transcript asynchronously: the pane paints
  // empty at scrollTop 0 and only then gets its items. Animating that first jump
  // made every open visibly scroll from the top through the whole transcript.
  describe('bottom anchoring', () => {
    const scrollBehaviors: (string | undefined)[] = []
    let originalScrollIntoView: typeof Element.prototype.scrollIntoView

    beforeEach(() => {
      scrollBehaviors.length = 0
      originalScrollIntoView = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
        scrollBehaviors.push(typeof arg === 'object' ? arg.behavior : undefined)
      }
    })
    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView
    })

    const last = (): string | undefined => scrollBehaviors[scrollBehaviors.length - 1]

    it('jumps a freshly opened chat to the bottom instantly, then animates new messages', () => {
      const slug = 'NAV-SCROLL-OPEN'
      const at = (type: string, payload: unknown): AgentEvent =>
        ({ ...base, caseSlug: slug, type, payload, turnId: 4 }) as AgentEvent
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
      act(() => {
        agentStore.hydrate(slug, 1, [
          at('turn.started', { userText: 'why did the ingest stall?' }),
          at('assistant.message', { text: 'the queue drained at 03:12' })
        ] as AgentEvent[])
      })
      expect(scrollBehaviors).toHaveLength(1)
      expect(last()).toBe('auto')

      // a reply arriving while the user is already watching still animates
      act(() => {
        agentStore.apply(at('assistant.message', { text: 'and here is why' }))
      })
      expect(last()).toBe('smooth')
    })

    // A mermaid fence mounts as its raw source and swaps in a taller SVG 150ms
    // later, so the transcript grows *after* the anchor has run and the chat
    // ends up scrolled short of the end. Re-anchoring on content resize is what
    // keeps it at the bottom; scrolling up must switch that off.
    describe('content settling after the anchor', () => {
      let fireResize: () => void
      let observed: Element[]

      beforeEach(() => {
        observed = []
        fireResize = () => undefined
        vi.stubGlobal(
          'ResizeObserver',
          class {
            constructor(cb: () => void) {
              fireResize = cb
            }
            observe(el: Element): void {
              observed.push(el)
            }
            disconnect(): void {
              observed = []
            }
          }
        )
      })
      afterEach(() => {
        vi.unstubAllGlobals()
      })

      /** jsdom has no layout, so drive the scroll geometry by hand */
      function sizeScroller(el: HTMLElement, scrollHeight: number, scrollTop: number): void {
        Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
        Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true })
        el.scrollTop = scrollTop
      }

      function renderPane(slug: string): HTMLElement {
        const at = (type: string, payload: unknown): AgentEvent =>
          ({ ...base, caseSlug: slug, type, payload, turnId: 1 }) as AgentEvent
        agentStore.hydrate(slug, 1, [
          at('turn.started', { userText: 'draw me the ingest path' }),
          at('assistant.message', { text: '```mermaid\ngraph TD;A-->B;\n```' })
        ] as AgentEvent[])
        const { container } = render(
          <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
        )
        return container.querySelector<HTMLElement>('.overflow-y-auto')!
      }

      it('re-anchors when the transcript grows after the initial anchor', () => {
        const scroller = renderPane('NAV-SETTLE')
        // The Composer's own density observer (Task 13) also registers against this
        // stub, so more than the transcript's own content div can appear here —
        // assert ChatPane's effect ran, not that it is the only one in the tree.
        expect(observed).toContain(scroller.querySelector('.space-y-3'))
        // anchored at the bottom of the pre-render height...
        sizeScroller(scroller, 500, 200)
        fireResize()
        expect(scroller.scrollTop).toBe(500)
        // ...and again once the diagram swaps in and the transcript gets taller
        sizeScroller(scroller, 900, 500)
        fireResize()
        expect(scroller.scrollTop).toBe(900)
      })

      it('leaves the view alone once the user has scrolled up to read', () => {
        const scroller = renderPane('NAV-SETTLE-READ')
        sizeScroller(scroller, 500, 40)
        fireEvent.scroll(scroller)
        // the diagram finishes rendering while the user is reading history
        sizeScroller(scroller, 900, 40)
        fireResize()
        expect(scroller.scrollTop).toBe(40)
      })
    })

    // The scroll container is not remounted per session, so an anchor keyed on
    // item counts alone leaves an equal-length chat sitting at the previous
    // chat's scrollTop.
    it('re-anchors when switching to a chat with the same number of items', () => {
      const slug = 'NAV-SCROLL-SWITCH'
      const at = (sessionId: number, type: string, payload: unknown): AgentEvent =>
        ({ ...base, caseSlug: slug, sessionId, type, payload, turnId: 1 }) as AgentEvent
      agentStore.hydrate(slug, 1, [
        at(1, 'turn.started', { userText: 'first chat' }),
        at(1, 'assistant.message', { text: 'first answer' })
      ] as AgentEvent[])
      agentStore.hydrate(slug, 2, [
        at(2, 'turn.started', { userText: 'second chat' }),
        at(2, 'assistant.message', { text: 'second answer' })
      ] as AgentEvent[])
      const { rerender } = render(
        <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
      )
      expect(last()).toBe('auto')
      rerender(<ChatPane slug={slug} sessionId={2} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
      expect(scrollBehaviors).toHaveLength(2)
      expect(last()).toBe('auto')
    })
  })

  it('opens the find overlay on Ctrl+F, rings matches, and refocuses composer on close', () => {
    const slug = 'NAV-FIND'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'braking failed' }, 1))
    agentStore.apply(at('assistant.message', { text: 'unrelated reply' }, 1))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    expect(screen.queryByLabelText('Find in chat')).toBeNull()

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByLabelText('Find in chat')
    expect(input).toBeTruthy()

    fireEvent.change(input, { target: { value: 'braking' } })
    const matchEl = container.querySelector('[data-item-index="0"]')
    expect(matchEl?.className).toContain('ring-2')
    expect(matchEl?.className).toContain('ring-signal')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('ingests a pasted file and stages it on the composer tray', async () => {
    const ingestContent = vi.fn(async (_slug: string, fileName: string) => ({
      record: { relPath: `evidence/${fileName}` },
      deduped: false
    }))
    window.argus.evidence = { ...window.argus.evidence, ingestContent } as never
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()

    render(<ChatPane slug="NAVAPI-1" sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)

    // Chromium supplies a name like this for every clipboard image paste — real or not,
    // the composer must ignore it and mint a sortable screenshot-style name instead.
    const file = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), {
      clipboardData: { files: [file], items: [], types: ['Files'] } as never
    })

    // the chip appears from a promise resolution — findBy, never a mock-gated waitFor
    const nameRe = /^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/
    expect(await screen.findByText(nameRe)).toBeTruthy()
    expect(ingestContent).toHaveBeenCalledWith(
      'NAVAPI-1',
      expect.stringMatching(nameRe),
      expect.any(Uint8Array)
    )
  })

  // Regression: deleting evidence from the Files card while its chip is still
  // staged in the composer must drop the chip too — otherwise the stale chip
  // sends `[evidence/<deleted-file>]` on send and the agent's Read fails on a
  // file that no longer exists.
  describe('pruning staged attachments on evidence:changed', () => {
    it('drops a staged ready chip whose relPath is no longer in the evidence list', async () => {
      const slug = 'NAV-PRUNE-GONE'
      composerAttachments.add(slug, 1, {
        id: 'a1',
        name: 'foo.txt',
        status: 'ready',
        relPath: 'evidence/foo.txt'
      })
      let changedCb: ((s: string) => void) | null = null
      window.argus.evidence = {
        ...window.argus.evidence,
        list: vi.fn(async () => []),
        onChanged: vi.fn((cb: (s: string) => void) => {
          changedCb = cb
          return vi.fn()
        })
      } as never
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
      expect(screen.getByText('foo.txt')).toBeTruthy()

      act(() => {
        changedCb?.(slug)
      })

      // the chip's disappearance is the tail of a promise resolution
      // (evidence.list) — assert it with a real DOM-removal wait, not a
      // mock-gated bare waitFor.
      await waitForElementToBeRemoved(() => screen.getByText('foo.txt'))
      expect(composerAttachments.get(slug, 1)).toHaveLength(0)
    })

    it('keeps a staged ready chip whose relPath is still in the evidence list', async () => {
      const slug = 'NAV-PRUNE-STILL'
      composerAttachments.add(slug, 1, {
        id: 'a1',
        name: 'foo.txt',
        status: 'ready',
        relPath: 'evidence/foo.txt'
      })
      let changedCb: ((s: string) => void) | null = null
      const list = vi.fn(async () => [{ relPath: 'evidence/foo.txt' }])
      window.argus.evidence = {
        ...window.argus.evidence,
        list,
        onChanged: vi.fn((cb: (s: string) => void) => {
          changedCb = cb
          return vi.fn()
        })
      } as never
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)

      act(() => {
        changedCb?.(slug)
      })
      // await the exact promise the component awaits (registered first, so
      // its .then runs before ours resumes) rather than polling with waitFor.
      await act(async () => {
        await list.mock.results[0]!.value
      })

      expect(screen.getByText('foo.txt')).toBeTruthy()
      expect(composerAttachments.get(slug, 1)).toHaveLength(1)
    })

    it('does not prune a pending attachment whose ingest is still in flight', async () => {
      const slug = 'NAV-PRUNE-PENDING'
      composerAttachments.add(slug, 1, { id: 'a1', name: 'shot.png', status: 'pending' })
      let changedCb: ((s: string) => void) | null = null
      const list = vi.fn(async () => [])
      window.argus.evidence = {
        ...window.argus.evidence,
        list,
        onChanged: vi.fn((cb: (s: string) => void) => {
          changedCb = cb
          return vi.fn()
        })
      } as never
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)

      // an unrelated evidence:changed fires while this attachment is still
      // pending (no relPath yet) — it must survive
      act(() => {
        changedCb?.(slug)
      })
      await act(async () => {
        await list.mock.results[0]!.value
      })

      expect(screen.getByText('shot.png')).toBeTruthy()
      expect(composerAttachments.get(slug, 1)).toHaveLength(1)
    })

    // Regression: `evidence:changed` also fires on the very ingest that
    // creates a chip — not just on deletion of an unrelated one — so pruning
    // must not eat the chip it just staged. Every other test in this
    // `describe` seeds `composerAttachments` directly BEFORE mount, so the
    // effect's very first (mount-time) read of the store already contains
    // the chip; a future refactor that snapshotted `attachments` once at
    // effect-setup time (instead of re-reading the store live inside the
    // `.then`) would slip past all of them undetected. This test instead
    // drives a REAL paste through `attachFiles()` so the chip is added AFTER
    // mount, and additionally proves the guard is still doing genuine live
    // work afterward (not just permanently disabled) by forcing a real
    // deletion once the race is over.
    it('survives the evidence:changed fired by its own in-flight ingest, and stays prunable afterward', async () => {
      const slug = 'NAV-PRUNE-SELF'
      let changedCb: ((s: string) => void) | null = null
      let relPath = ''
      const list = vi.fn(async () => (relPath ? [{ relPath }] : []))
      const ingestContent = vi.fn(async (_slug: string, fileName: string) => {
        relPath = `evidence/${fileName}`
        // Mirrors real main-process ordering: evidenceChangedB broadcasts
        // BEFORE the IPC reply is sent, so the renderer's evidence:changed
        // listener — and the evidence.list() it triggers — fires and starts
        // resolving WHILE this very ingest is still in flight, racing its
        // own resolution. `list`'s `.then` is registered here, synchronously,
        // before this function returns, so it settles before attachFiles'
        // own continuation (registered when it awaited this promise) does.
        changedCb?.(slug)
        return { record: { relPath }, deduped: false }
      })
      window.argus.evidence = {
        ...window.argus.evidence,
        list,
        ingestContent,
        onChanged: vi.fn((cb: (s: string) => void) => {
          changedCb = cb
          return vi.fn()
        })
      } as never

      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)

      const file = new File([new Uint8Array(4)], 'race.txt', { type: 'text/plain' })
      fireEvent.paste(screen.getByPlaceholderText(/Message the analyst/i), {
        clipboardData: { files: [file], items: [], types: ['Files'] } as never
      })

      // The chip's `title` only carries its relPath once it is 'ready' (see
      // AttachmentChip) — waiting on that, rather than on the name text
      // (present from the instant it lands as 'pending'), guarantees this
      // resolves only after the self-triggered prune pass has ALREADY run
      // and left the chip alone: reaching 'ready' means attachFiles' own
      // `.then` ran, which per the ordering above only happens after the
      // race's `list().then(...)` settled.
      const chip = await screen.findByTitle('evidence/race.txt')
      expect(chip).toBeTruthy()
      expect(composerAttachments.get(slug, 1)).toHaveLength(1)
      expect(composerAttachments.get(slug, 1)[0]!.status).toBe('ready')
      expect(composerAttachments.get(slug, 1)[0]!.relPath).toBe('evidence/race.txt')

      // Prove the guard isn't just quietly disabled for this chip — once the
      // evidence genuinely is gone, a later evidence:changed must still
      // prune it.
      relPath = ''
      act(() => {
        changedCb?.(slug)
      })
      await waitForElementToBeRemoved(() => screen.getByText('race.txt'))
      expect(composerAttachments.get(slug, 1)).toHaveLength(0)
    })

    it('unsubscribes from evidence:changed on unmount', () => {
      const slug = 'NAV-PRUNE-UNMOUNT'
      const off = vi.fn()
      window.argus.evidence = {
        ...window.argus.evidence,
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => off)
      } as never
      const { unmount } = render(
        <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
      )
      expect(off).not.toHaveBeenCalled()
      unmount()
      expect(off).toHaveBeenCalledTimes(1)
    })
  })
})
