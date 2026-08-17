import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateStubModule } from './stub'
import { startPtcServer } from './server'

export const PTC_FOREGROUND_MAX_CALLS = 50
export const PTC_FOREGROUND_STDOUT_CAP = 50_000
export const PTC_FOREGROUND_TIMEOUT_MS = 120_000
export const PTC_DISTILL_MAX_CALLS = 200
export const PTC_DISTILL_STDOUT_CAP = 100_000
export const PTC_DISTILL_TIMEOUT_MS = 600_000

export interface PtcRunOpts {
  script: string
  allowedTools: string[]
  dispatch: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  maxCalls: number
  stdoutCapBytes: number
  timeoutMs: number
  /** Test seam; default process.execPath with ELECTRON_RUN_AS_NODE (spawning the Electron
   *  binary as node — never a .js CLI, see argus-electron-execpath-spawn-trap). */
  nodeBin?: string
}
export interface PtcRunResult {
  stdout: string
  stdoutBytesTotal: number
  stdoutBytesOmitted: number
  exitCode: number | null
  timedOut: boolean
  calls: number
}

/** 40/60 head/tail split; a textual marker ALONE gets re-truncated by downstream layers and
 *  misread by the model, hence the explicit byte fields on the result too. */
function capStdout(buf: Buffer, cap: number): { text: string; omitted: number } {
  if (buf.length <= cap) return { text: buf.toString('utf8'), omitted: 0 }
  const head = Math.floor(cap * 0.4)
  const tail = cap - head
  const omitted = buf.length - cap
  return {
    text:
      buf.subarray(0, head).toString('utf8') +
      `\n[… ${omitted} bytes omitted …]\n` +
      buf.subarray(buf.length - tail).toString('utf8'),
    omitted
  }
}

/** Explicit allowlist — a broad prefix pass-through is exactly how Hermes leaked webhook URLs. */
function scrubbedEnv(port: number, token: string): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'COMSPEC'
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.ELECTRON_RUN_AS_NODE = '1'
  env.ARGUS_PTC_PORT = String(port)
  env.ARGUS_PTC_TOKEN = token
  return env
}

export async function runToolScript(opts: PtcRunOpts): Promise<PtcRunResult> {
  const srv = await startPtcServer({
    dispatch: opts.dispatch,
    allowedTools: opts.allowedTools,
    maxCalls: opts.maxCalls
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ptc-'))
  try {
    fs.writeFileSync(path.join(dir, 'argus_tools.js'), generateStubModule(opts.allowedTools))
    const scriptPath = path.join(dir, 'script.js')
    fs.writeFileSync(scriptPath, opts.script)
    const child = spawn(opts.nodeBin ?? process.execPath, [scriptPath], {
      cwd: dir,
      env: scrubbedEnv(srv.port, srv.token),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => chunks.push(d)) // stderr folds into stdout for the model
    let timedOut = false
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, opts.timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    const all = Buffer.concat(chunks)
    const { text, omitted } = capStdout(all, opts.stdoutCapBytes)
    return {
      stdout: text,
      stdoutBytesTotal: all.length,
      stdoutBytesOmitted: omitted,
      exitCode,
      timedOut,
      calls: srv.calls
    }
  } finally {
    srv.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
