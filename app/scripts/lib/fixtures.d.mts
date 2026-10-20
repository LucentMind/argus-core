// Types for fixtures.mjs (the distillation fixture loader). Keep in step with the
// implementation: Task 4's TS test under src/main/** imports the module through this file.
export interface FixtureAssetSkill {
  name: string
  description: string
  body: string
}
export interface FixtureAssetReference {
  relPath: string
  tier: string | null
  body: string
}
export interface FixtureMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface FixtureSession {
  title: string
  messages: FixtureMessage[]
}
export interface FixtureFinding {
  summary: string
  reviewState: 'accepted' | 'pending' | 'rejected'
  role: string | null
  session: number
}
export interface FixtureToolCall {
  session: number
  turn: number
  tool: string
  detail: string
}
export interface FixtureClose {
  resolution: string
  distill: boolean
  attribution: boolean
}
export type FixtureAction =
  | { type: 'retract-finding'; finding: number; reason: string }
  | {
      type: 'reject-proposal'
      proposalType: 'skill-edit' | 'reference-edit'
      target: string
      reason: 'wrong' | 'overfit' | 'overgeneric' | 'duplicate' | 'other'
    }
export interface ExpectedJob {
  kind: 'case' | 'attribution'
  state: 'done' | 'failed'
  pipeline: 'v2' | 'v3' | null
  stages: string[]
  attributionSkipped: string | null
  attributionError: boolean
  costUsd: number
}
export interface ExpectedRow {
  kind: string
  name: string
  applied: 0 | 1 | null
  verdict: string | null
  override: { verdict: string; source: string } | null
  domain: string
  outcome: string
}
export interface ExpectedUi {
  libraryChip: { asset: string; text: string | null } | null
  observabilityLists: string[]
  observabilityOmits: string[]
  runsRailLabel: string | null
  runDetailSkipped: string | null
}
export interface Expected {
  jobs: ExpectedJob[]
  attributions: ExpectedRow[]
  fakeCalls: Record<string, number>
  ui: ExpectedUi
}
export interface Fixture {
  slug: string
  title: string
  jiraKey: string | null
  scenario: string
  settings: { pipeline: 'v2' | 'v3' }
  assets: { skills: FixtureAssetSkill[]; references: FixtureAssetReference[]; memories: string[] }
  sessions: FixtureSession[]
  findings: FixtureFinding[]
  toolCalls: FixtureToolCall[]
  close: FixtureClose | null
  trigger?: 'redistill'
  stages: Record<
    string,
    {
      text?: string
      throw?: string
      capHit?: 'iterations' | 'timeout'
      capSubtype?: string
      usage?: Record<string, number>
      turnCount?: number
      toolCallCount?: number
    }
  >
  actions: FixtureAction[]
  expected: Expected
}
export interface SeedIds {
  sessionIds: number[]
  findingIds: number[]
}
export interface ActualState {
  jobs: {
    id: number
    kind: string
    state: string
    pipeline: string | null
    stages: Record<string, unknown> | null
    costUsd: number | null
    error: string | null
  }[]
  rows: {
    kind: string
    name: string
    applied: number | null
    verdict: string | null
    overrideVerdict: string | null
    overrideSource: string | null
    domain: string
    outcome: string
    jobId: number
    cites: unknown[]
  }[]
  fakeCalls: Record<string, number>
}
export const FIXTURES_DIR: string
export function listFixtures(dir?: string): Fixture[]
export function loadFixture(file: string): Fixture
export function writeFixtureAssets(home: string, fx: Fixture): void
export function seedFixtureCase(
  db: import('node:sqlite').DatabaseSync,
  caseId: number,
  fx: Fixture
): SeedIds
export function resolveStages(fx: Fixture, ids: SeedIds): Fixture['stages']
export function writeFakeStages(fakeDir: string, slug: string, stages: Fixture['stages']): string
export function settingsFor(fx: Fixture): { pipeline: 'v2' | 'v3'; attribution: { default: true } }
export function readFakeCalls(fakeDir: string, slug: string): Record<string, number>
export function readActual(
  db: import('node:sqlite').DatabaseSync,
  slug: string,
  fakeCalls: Record<string, number>
): ActualState
export function checkExpected(actual: ActualState, expected: Expected): string[]
