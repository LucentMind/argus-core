// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { FindingsPane } from '../FindingsPane'
import type { FindingRow } from '../../../../shared/observability'

/**
 * A whole-branch review demonstrated that the existing FindingsPane/FindingCard suites stay
 * green even when every reveal class is deleted from the action cluster (reverting the
 * branch's headline fix back to always-visible buttons) and even when the severity colours are
 * swapped. Both changes are invisible to jsdom's DOM assertions unless something asserts the
 * class *names* directly — jsdom applies no stylesheet, so `getComputedStyle` proves nothing
 * here. This file exists to make those two regressions fail loudly.
 */

function row(over: Partial<FindingRow>): FindingRow {
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

const list = vi.fn()

beforeEach(() => {
  list.mockReset()
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) }
  } as never // test double for the preload bridge
})

describe('FindingCard reveal contract', () => {
  it('hides the action cluster at rest without ever removing it from the tab order', async () => {
    list.mockResolvedValue([
      row({
        id: 1,
        summary: 'Reveal me',
        layer: 'security',
        severity: 'major',
        mode: 'review',
        diffPath: 'a.ts'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('Reveal me')).closest('li') as HTMLElement
    // The reveal is inert if the ancestor group name is missing — group-hover/f: variants on
    // the cluster only mean anything if the <li> actually carries `group/f`.
    expect(item).toHaveClass('group/f')

    const trailing = within(item).getByTestId('finding-trailing')
    const cluster = trailing.querySelector(':scope > div')
    expect(cluster).not.toBeNull()

    // At rest: invisible and click-inert, but NEVER `hidden` — a display:none subtree drops out
    // of the tab order, and these buttons are the only keyboard path to comment/apply.
    expect(cluster).toHaveClass('opacity-0')
    expect(cluster).toHaveClass('pointer-events-none')
    expect(cluster).not.toHaveClass('hidden')

    // The mouse path: static classes keyed off the <li>'s `group/f`, present at rest regardless
    // of focus state. Deleting these four classes is the exact regression the whole-branch
    // review found — the existing suite stayed green because nothing asserted their names.
    expect(cluster).toHaveClass('group-hover/f:opacity-100')
    expect(cluster).toHaveClass('group-hover/f:pointer-events-auto')

    // The keyboard path: focusing the trailing cell flips local React state (there is no
    // `group-focus-within` variant here — the trailing cell has no group of its own), which
    // swaps the conditional half of the class string.
    fireEvent.focus(trailing)
    expect(cluster).toHaveClass('opacity-100')
    expect(cluster).toHaveClass('pointer-events-auto')
    expect(cluster).not.toHaveClass('opacity-0')
    expect(cluster).not.toHaveClass('pointer-events-none')

    fireEvent.blur(trailing)
    expect(cluster).toHaveClass('opacity-0')
    expect(cluster).toHaveClass('pointer-events-none')
  })

  it('review-mode cards carry comment+apply and never the thumb buttons', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'Review card', mode: 'review', diffPath: 'a.ts' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('Review card')).closest('li') as HTMLElement
    expect(within(item).getByLabelText('Post as PR comment')).toBeInTheDocument()
    expect(within(item).getByLabelText('Apply change and push')).toBeInTheDocument()
    expect(within(item).queryByLabelText('Mark finding good')).not.toBeInTheDocument()
    expect(within(item).queryByLabelText('Mark finding not useful')).not.toBeInTheDocument()
  })

  it('investigation-mode cards carry the thumb buttons and never comment+apply', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'Triage card', mode: 'investigation' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const item = (await screen.findByText('Triage card')).closest('li') as HTMLElement
    expect(within(item).getByLabelText('Mark finding good')).toBeInTheDocument()
    expect(within(item).getByLabelText('Mark finding not useful')).toBeInTheDocument()
    expect(within(item).queryByLabelText('Post as PR comment')).not.toBeInTheDocument()
    expect(within(item).queryByLabelText('Apply change and push')).not.toBeInTheDocument()
  })
})

describe('FindingCard severity palette', () => {
  it('critical maps to text-danger and bg-danger', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'sev critical', severity: 'critical', layer: 'tests', mode: 'review' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('sev critical')).closest('li') as HTMLElement
    expect(within(item).getByText('critical')).toHaveClass('text-danger')
    expect(item.querySelector('[data-severity="critical"]')).toHaveClass('bg-danger')
  })

  it('major maps to text-defect and bg-defect', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'sev major', severity: 'major', layer: 'tests', mode: 'review' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('sev major')).closest('li') as HTMLElement
    expect(within(item).getByText('major')).toHaveClass('text-defect')
    expect(item.querySelector('[data-severity="major"]')).toHaveClass('bg-defect')
  })

  it('minor maps to text-dim and bg-mute', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'sev minor', severity: 'minor', layer: 'tests', mode: 'review' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('sev minor')).closest('li') as HTMLElement
    expect(within(item).getByText('minor')).toHaveClass('text-dim')
    expect(item.querySelector('[data-severity="minor"]')).toHaveClass('bg-mute')
  })
})

describe('FindingCard role chip', () => {
  it('renders no chip when role is null', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'No role here', role: null })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const item = (await screen.findByText('No role here')).closest('li') as HTMLElement
    expect(within(item).queryByText('ROOT CAUSE')).not.toBeInTheDocument()
  })

  it('root-cause renders a distinct accent chip', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'The root of it', role: 'root-cause' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const item = (await screen.findByText('The root of it')).closest('li') as HTMLElement
    const chip = within(item).getByText('ROOT CAUSE')
    expect(chip).toHaveClass('text-signal')
    expect(chip).toHaveClass('border-signal/35')
  })

  it('other roles render a plain dim chip', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'Just a symptom', role: 'symptom' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const item = (await screen.findByText('Just a symptom')).closest('li') as HTMLElement
    const chip = within(item).getByText('symptom')
    expect(chip).toHaveClass('text-mute')
    expect(chip).not.toHaveClass('text-signal')
  })
})

describe('colour token guard', () => {
  const THEME_CSS = path.resolve(__dirname, '../../assets/theme.css')
  const CHECKED_FILES = [
    path.resolve(__dirname, '../FindingCard.tsx'),
    path.resolve(__dirname, '../FindingsPane.tsx')
  ]

  /** The branch's motivating bug was `text-warn` — a class naming a token that does not exist,
   *  which Tailwind silently compiles to nothing (no build error, no visible box, just an
   *  invisible label). Derive the real token list from theme.css itself, not a hardcoded copy
   *  of it, so this guard can't drift out of sync with the file it checks. */
  function themeColorNames(): Set<string> {
    const css = fs.readFileSync(THEME_CSS, 'utf8')
    const block = css.match(/@theme inline\s*\{([\s\S]*?)\n\}/)
    if (!block) throw new Error(`no "@theme inline" block found in ${THEME_CSS}`)
    const names = new Set<string>()
    for (const m of block[1].matchAll(/--color-([a-zA-Z0-9]+):/g)) names.add(m[1])
    return names
  }

  // Utilities that share a colour prefix but name something other than a colour: font-size
  // keywords, text-alignment keywords, and border-side keywords. Everything else surviving
  // the arbitrary-value filter (`text-[10px]`) and the opacity-suffix strip (`/35`) must name
  // a real token.
  const NON_COLOR_SUFFIX: Record<string, Set<string>> = {
    text: new Set(['xs', 'sm', 'base', 'lg', 'xl', 'left', 'right', 'center']),
    border: new Set(['t', 'b', 'l', 'r', 'x', 'y']),
    bg: new Set(),
    ring: new Set(),
    fill: new Set(),
    accent: new Set()
  }

  function colorClassesIn(file: string): { prefix: string; name: string }[] {
    const src = fs.readFileSync(file, 'utf8')
    const found: { prefix: string; name: string }[] = []
    for (const m of src.matchAll(/\b(bg|text|border|ring|fill|accent)-([A-Za-z0-9.[\]/-]+)/g)) {
      const [, prefix, rawSuffix] = m
      if (rawSuffix.includes('[')) continue // arbitrary value, e.g. text-[10px] — not a token
      const name = rawSuffix.replace(/\/\d+$/, '') // strip opacity modifier, e.g. /35
      if (NON_COLOR_SUFFIX[prefix]?.has(name)) continue
      found.push({ prefix, name })
    }
    return found
  }

  it('sanity: the extractor actually finds colour classes in both files', () => {
    // A guard that vacuously passes because it found nothing to check is worthless — this
    // pins the extractor to a nonzero count so an accidental regex break shows up here first.
    const total = CHECKED_FILES.reduce((n, f) => n + colorClassesIn(f).length, 0)
    expect(total).toBeGreaterThan(20)
  })

  it('every colour utility in FindingCard.tsx and FindingsPane.tsx names a real theme token', () => {
    const tokens = themeColorNames()
    expect(tokens.size).toBeGreaterThan(5) // sanity: the @theme inline block was actually found

    const offenders: string[] = []
    for (const file of CHECKED_FILES) {
      for (const { prefix, name } of colorClassesIn(file)) {
        if (!tokens.has(name)) offenders.push(`${path.basename(file)}: ${prefix}-${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
