import { describe, it, expect } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodeGraphService } from '../codeGraph'

const execFileAsync = promisify(execFile)

function graphifyOnPath(): boolean {
  try {
    execFileSync('graphify', ['--version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!graphifyOnPath())('code graph end-to-end (requires graphify)', () => {
  it('builds a real graph for a tiny fixture repo and reports ok status', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-repo-'))
    const g = (...a: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync('git', a, { cwd: repo })
    await g('init')
    await g('config', 'user.email', 't@t')
    await g('config', 'user.name', 't')
    fs.writeFileSync(
      path.join(repo, 'main.py'),
      'def helper():\n    return 1\n\ndef entry():\n    return helper()\n'
    )
    await g('add', '.')
    await g('commit', '-m', 'fixture')

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-home-'))
    const svc = new CodeGraphService({
      argusHome: home,
      pathOf: () => 'graphify',
      recompute: () => {},
      broadcast: () => {}
    })
    expect(svc.build(repo, null)).toEqual({ started: true })
    // real extraction on 1 file is fast, but allow slack
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const poll = setInterval(() => {
        void svc.status(repo).then((rows) => {
          if (rows[0]?.status === 'ok') {
            clearInterval(poll)
            resolve()
          } else if (rows[0]?.status === 'failed') {
            clearInterval(poll)
            reject(new Error(rows[0].error))
          } else if (Date.now() - t0 > 120_000) {
            clearInterval(poll)
            reject(new Error('timeout'))
          }
        })
      }, 500)
    })
    const [row] = await svc.status(repo)
    expect(row.behind).toBe(0)
    // graph.json exists where the skill expects it
    const repoDirs = fs.readdirSync(path.join(home, 'graphs'))
    expect(repoDirs).toHaveLength(1)
    const graphJson = path.join(home, 'graphs', repoDirs[0], '_root', 'graphify-out', 'graph.json')
    expect(fs.existsSync(graphJson)).toBe(true)
  }, 180_000)
})
