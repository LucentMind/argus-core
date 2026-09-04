// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RunDetail } from '../RunDetail'
import type { DistillRunDetail, DistillJobRow } from '../../../../../shared/distill'

const job = (over: Partial<DistillJobRow> = {}): DistillJobRow => ({
  id: 142,
  caseSlug: 'navpor-10505',
  state: 'done',
  error: null,
  itemCount: 0,
  createdAt: '2026-09-04T13:00:00.000Z',
  finishedAt: '2026-09-04T13:06:00.000Z',
  costUsd: 1.63,
  turnCount: 8,
  toolCallCount: 7,
  promptChars: 58950,
  dryRun: true,
  ...over
})
const DOSSIER_RAW = 'DOSSIER RAW OUTPUT'
const detail = (): DistillRunDetail => ({
  job: job({ itemCount: null }),
  pipeline: 'v3',
  stages: {
    dossier: {
      promptHash: 'h',
      promptChars: 58950,
      rawOutput: DOSSIER_RAW,
      usage: { costUsd: 1.04 }
    },
    summary: {
      promptHash: 'h',
      promptChars: 10496,
      rawOutput: '{"summary":null}',
      usage: { costUsd: 0.15 }
    },
    candidates: {
      promptHash: 'h',
      promptChars: 36420,
      rawOutput: 'CANDS RAW',
      usage: { costUsd: 0.44 }
    },
    materialize: [
      {
        promptHash: 'h',
        promptChars: 1,
        rawOutput: 'MAT RAW',
        type: 'reference-edit',
        target: 'android-sdk-log-patterns'
      }
    ]
  },
  dropped: [
    { type: 'skill-edit', target: 'diagnose-reroute-race', title: 'dup', reason: 'duplicate' }
  ],
  trajectory: [{ turn: 1, tool: 'mcp__argus__read_transcript', argsSummary: '{"session_id":1}' }],
  rawOutput: '{}',
  inputSnapshotChars: 58950,
  parsed: {
    dossier: {
      scope: {
        status: 'closed',
        resolution: 'solved',
        settled: true,
        note: 'every finding is [pending]'
      },
      root_cause: null,
      confirmed_fix: null,
      rejected_hypotheses: [],
      diagnostic_path: [
        {
          step: 'Checked reroute-vs-clear ordering',
          observation: 'late reroute lands',
          discriminated: 'race vs config',
          cites: [{ finding: 139 }, { session: 1, turn: 42 }]
        }
      ],
      durable_facts: [
        {
          fact: 'doNotCancelRerouteOnBackToRoute defaults true',
          quote: 'q',
          scope: 'NN < 133c753',
          cites: [{ evidence: 'build.txt' }]
        }
      ],
      user_corrections: []
    },
    summaryPresent: true,
    summary: null,
    candidates: [
      {
        kind: 'fact',
        type: 'reference-edit',
        target: 'android-sdk-log-patterns',
        title: 'deliver-anyway log line',
        outline: 'o',
        evidence: ['durable_facts[0]'],
        related: [],
        generalization: 'g',
        routing_rationale: 'r',
        confidence: 0.8
      },
      {
        kind: 'procedure',
        type: 'skill-edit',
        target: 'diagnose-reroute-race',
        title: 'dup',
        outline: 'o',
        evidence: ['root_cause'],
        related: [],
        generalization: 'g',
        routing_rationale: 'r',
        confidence: 0.5
      }
    ],
    materialized: [
      {
        type: 'reference-edit',
        target: 'android-sdk-log-patterns',
        output: {
          basis: 'a basis line',
          ops: [{ op: 'append-section', heading: '## Log lines', content: 'new line' }]
        },
        diff: { current: 'a\n', applied: 'a\nnew line\n' }
      }
    ]
  }
})

describe('RunDetail', () => {
  it('renders the strip in DAG order with the dry-run staged node skipped', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    const nodes = screen.getAllByTestId(/^strip-/)
    expect(nodes.map((n) => n.dataset.testid)).toEqual([
      'strip-input',
      'strip-dossier',
      'strip-summary',
      'strip-candidates',
      'strip-veto',
      'strip-materialize',
      'strip-validators',
      'strip-staged'
    ])
    expect(screen.getByTestId('strip-staged')).toHaveTextContent('not staged (dry run)')
    expect(screen.getByTestId('strip-staged').dataset.state).toBe('skipped')
  })
  it('renders the dossier structured with cite chips, and raw on toggle', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    expect(screen.getByText('Checked reroute-vs-clear ordering')).toBeInTheDocument()
    expect(screen.getByText('finding 139')).toBeInTheDocument()
    expect(screen.getByText('s1:t42')).toBeInTheDocument()
    expect(screen.getByText('ev build.txt')).toBeInTheDocument()
    expect(screen.queryByText(DOSSIER_RAW)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show raw dossier' }))
    expect(screen.getByText(DOSSIER_RAW)).toBeInTheDocument()
  })
  it('marks candidates kept or vetoed by joining the drop list', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    const rows = screen.getAllByTestId('candidate-row')
    expect(rows[0]).toHaveTextContent('kept')
    expect(rows[1]).toHaveTextContent('vetoed · duplicate')
  })
  it('says the summary stage returned null rather than hiding it', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    expect(screen.getByTestId('card-summary')).toHaveTextContent('null · not recurrence-relevant')
  })
  it('renders a materialize card with basis, ops and a diff against the current file', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    const card = screen.getByTestId('card-materialize-0')
    expect(card).toHaveTextContent('a basis line')
    expect(card).toHaveTextContent('append-section · ## Log lines')
    expect(card).toHaveTextContent('against current file')
  })
  it('falls back to raw when a stage did not parse', () => {
    const d = detail()
    d.parsed.candidates = null
    render(<RunDetail detail={d} progress={null} />)
    expect(screen.getByTestId('card-candidates')).toHaveTextContent('CANDS RAW')
  })
  it('renders the trajectory as a tool-call list, collapsed', () => {
    render(<RunDetail detail={detail()} progress={null} />)
    expect(screen.getByText(/Trajectory \(1 tool call\)/)).toBeInTheDocument()
  })
  it('re-syncs a stage card from raw to structured when a running job finishes and re-fetches', () => {
    const d1 = detail()
    d1.parsed.dossier = null
    const { rerender } = render(<RunDetail detail={d1} progress={null} />)
    expect(screen.getByTestId('card-dossier')).toHaveTextContent(DOSSIER_RAW)
    expect(screen.queryByText('Checked reroute-vs-clear ordering')).not.toBeInTheDocument()

    const d2 = detail()
    rerender(<RunDetail detail={d2} progress={null} />)
    expect(screen.getByTestId('card-dossier')).toHaveTextContent(
      'Checked reroute-vs-clear ordering'
    )
    expect(screen.queryByText(DOSSIER_RAW)).not.toBeInTheDocument()
  })
  it('drops malformed trajectory entries instead of throwing', () => {
    const d = detail()
    // deliberately malformed wire data for the guard — trajectory is `unknown[] | null`
    d.trajectory = [{ turn: 1, tool: 'x', argsSummary: '{}' }, null, 'junk']
    expect(() => render(<RunDetail detail={d} progress={null} />)).not.toThrow()
    expect(screen.getByText(/Trajectory \(1 tool call\)/)).toBeInTheDocument()
  })
  it('namespaces card ids by job so two RunDetails can render side by side without id collisions', () => {
    render(
      <>
        <RunDetail detail={{ ...detail(), job: job({ id: 1, itemCount: null }) }} progress={null} />
        <RunDetail detail={{ ...detail(), job: job({ id: 2, itemCount: null }) }} progress={null} />
      </>
    )
    const job1Ids = document.querySelectorAll('[id^="card-1-"]')
    const job2Ids = document.querySelectorAll('[id^="card-2-"]')
    expect(job1Ids.length).toBeGreaterThan(0)
    expect(job2Ids.length).toBeGreaterThan(0)
    const allIds = [...document.querySelectorAll('[id^="card-"]')].map((el) => el.id)
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})
