import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postAutonomyReport } from '../post'
import { defaultSettings } from '../../../../shared/settings'

let dir: string
let file: string

function deps(
  callTool = vi.fn().mockResolvedValue('Created page at https://x.atlassian.net/wiki/p/1')
): {
  settings: () => ReturnType<typeof defaultSettings>
  callTool: typeof callTool
  resolveRovoInstanceId: () => string
  siteUrl: () => Promise<string>
  now: () => Date
} {
  const s = defaultSettings()
  s.rca.confluenceSpaceKey = 'ENG'
  return {
    settings: () => s,
    callTool,
    resolveRovoInstanceId: () => 'rovo-1',
    siteUrl: () => Promise.resolve('https://x.atlassian.net'),
    now: () => new Date('2026-08-12T12:00:00Z')
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-post-'))
  file = path.join(dir, 'autonomy-review-2026-08-12.md')
  fs.writeFileSync(file, '# Autonomy review — 2026-08-12\n')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('postAutonomyReport', () => {
  it('creates a Confluence page and records the sidecar', async () => {
    const d = deps()
    const res = await postAutonomyReport(d, file)
    expect(res.confluencePage?.ok).toBe(true)
    expect(res.confluencePage?.url).toBe('https://x.atlassian.net/wiki/p/1')
    expect(d.callTool).toHaveBeenCalledWith('rovo-1', 'createConfluencePage', {
      cloudId: 'https://x.atlassian.net',
      spaceId: 'ENG',
      title: 'Autonomy review — 2026-08-12',
      body: '# Autonomy review — 2026-08-12\n',
      contentFormat: 'markdown'
    })
    const sidecar = JSON.parse(fs.readFileSync(`${file}.post.json`, 'utf8'))
    expect(sidecar.confluencePage.ok).toBe(true)
  })

  it('is idempotent: an ok sidecar short-circuits without a second tool call', async () => {
    fs.writeFileSync(
      `${file}.post.json`,
      JSON.stringify({ confluencePage: { ok: true, url: 'https://prior', at: 'x' } })
    )
    const d = deps()
    const res = await postAutonomyReport(d, file)
    expect(res.confluencePage?.url).toBe('https://prior')
    expect(d.callTool).not.toHaveBeenCalled()
  })

  it('records a failure without throwing', async () => {
    const d = deps(vi.fn().mockRejectedValue(new Error('403')))
    const res = await postAutonomyReport(d, file)
    expect(res.confluencePage?.ok).toBe(false)
    expect(res.confluencePage?.error).toBe('403')
  })

  it('demands a space key up front', async () => {
    const d = deps()
    d.settings().rca.confluenceSpaceKey = ''
    const bare = {
      ...d,
      settings: () => {
        const s = defaultSettings()
        return s
      }
    }
    await expect(postAutonomyReport(bare, file)).rejects.toThrow(/space key/i)
  })
})
