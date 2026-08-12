import fs from 'node:fs'
import path from 'node:path'
import type { PostResults } from '../../../shared/rca'
import type { AppSettings } from '../../../shared/settings'

export interface AutonomyPostDeps {
  settings: () => AppSettings
  callTool: (instanceId: string, name: string, args: Record<string, unknown>) => Promise<string>
  resolveRovoInstanceId: () => string
  siteUrl: () => Promise<string | null>
  now?: () => Date
}

/** Same trick as rca/post.ts's private helper (Rovo tools answer in prose, not JSON) —
 *  deliberately duplicated: a report module importing RCA internals is the wrong coupling. */
function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/)
  if (!m) return null
  return m[0].replace(/[)\].,;]+$/, '')
}

function sidecarPath(file: string): string {
  return `${file}.post.json`
}

function readSidecar(file: string): PostResults {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8')) as PostResults
  } catch {
    return {}
  }
}

/**
 * Posts a generated autonomy report as a Confluence page through the same Rovo connector
 * seam as postRcaReport. Global report ⇒ no Jira comment target. Idempotent via a sidecar
 * `<file>.post.json`: an ok page is never re-created; a failure is recorded, not thrown.
 */
export async function postAutonomyReport(
  deps: AutonomyPostDeps,
  file: string
): Promise<PostResults> {
  const results = readSidecar(file)
  if (results.confluencePage?.ok) return results

  const spaceKey = deps.settings().rca.confluenceSpaceKey
  if (!spaceKey) {
    throw new Error('Set a Confluence space key in Settings → RCA before posting.')
  }
  const rovo = deps.resolveRovoInstanceId()
  const cloudId = await deps.siteUrl()
  if (!cloudId) {
    throw new Error(
      'Cannot resolve the Atlassian site for posting — authorize the connector in Settings → Connectors.'
    )
  }
  const body = fs.readFileSync(file, 'utf8')
  const title = `Autonomy review — ${path.basename(file, '.md').replace(/^autonomy-review-/, '')}`
  const at = (deps.now ?? (() => new Date()))().toISOString()
  try {
    const raw = await deps.callTool(rovo, 'createConfluencePage', {
      cloudId,
      spaceId: spaceKey,
      title,
      body,
      contentFormat: 'markdown'
    })
    results.confluencePage = { ok: true, url: extractFirstUrl(raw) ?? undefined, at }
  } catch (err) {
    results.confluencePage = { ok: false, error: (err as Error).message, at }
  }
  fs.writeFileSync(sidecarPath(file), JSON.stringify(results))
  return results
}
