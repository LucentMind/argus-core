import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ExternalAppHost,
  type ProcessHandle,
  type ProcessSpawner,
  type OpenExternalAppInput
} from '../externalAppHost'

class FakeHandle implements ProcessHandle {
  killed: Array<'SIGTERM' | 'SIGKILL'> = []
  focused = 0
  written: string[] = []
  private stdout: ((l: string) => void)[] = []
  private stderrCbs: ((c: string) => void)[] = []
  private exitCbs: ((c: number | null) => void)[] = []
  constructor(readonly pid: number) {}
  writeLine(line: string): void {
    this.written.push(line)
  }
  onStdoutLine(cb: (l: string) => void): void {
    this.stdout.push(cb)
  }
  onStderr(cb: (c: string) => void): void {
    this.stderrCbs.push(cb)
  }
  onExit(cb: (c: number | null) => void): void {
    this.exitCbs.push(cb)
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.killed.push(signal)
  }
  focus(): void {
    this.focused++
  }
  // test helpers
  emitStdout(line: string): void {
    for (const cb of this.stdout) cb(line)
  }
  emitStderr(chunk: string): void {
    for (const cb of this.stderrCbs) cb(chunk)
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code)
  }
}

class FakeSpawner implements ProcessSpawner {
  spawned: Array<{ cmd: string; args: string[]; opts: { cwd: string; env?: Record<string, string> } }> = []
  handles: FakeHandle[] = []
  private next = 1000
  spawn(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): ProcessHandle {
    this.spawned.push({ cmd, args, opts })
    const h = new FakeHandle(this.next++)
    this.handles.push(h)
    return h
  }
}

const input = (over: Partial<OpenExternalAppInput> = {}): OpenExternalAppInput => ({
  caseSlug: 'CASE-A',
  packId: 'ext-pack',
  windowId: 'sim',
  title: 'Sim',
  entry: '/packs/ext-pack/bin/sim.mjs',
  cwd: '/packs/ext-pack',
  runtime: 'node',
  ...over
})

let spawner: FakeSpawner
let host: ExternalAppHost
let changes: number

beforeEach(() => {
  spawner = new FakeSpawner()
  changes = 0
  host = new ExternalAppHost({ spawner, logDir: '/tmp/logs', onChange: () => changes++, dispatchTimeoutMs: 50 })
})

describe('ExternalAppHost', () => {
  it('runtime:node spawns the bundled runtime with ELECTRON_RUN_AS_NODE and entry as arg', () => {
    host.open(input())
    const s = spawner.spawned[0]
    expect(s.cmd).toBe(process.execPath)
    expect(s.args).toEqual(['/packs/ext-pack/bin/sim.mjs'])
    expect(s.opts.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(s.opts.cwd).toBe('/packs/ext-pack')
  })

  it('no runtime spawns the entry directly as an executable', () => {
    host.open(input({ runtime: undefined, entry: '/packs/ext-pack/bin/sim.exe' }))
    const s = spawner.spawned[0]
    expect(s.cmd).toBe('/packs/ext-pack/bin/sim.exe')
    expect(s.args).toEqual([])
  })

  it('open is idempotent — re-open focuses, does not re-spawn', () => {
    host.open(input())
    host.open(input())
    expect(spawner.spawned.length).toBe(1)
    expect(spawner.handles[0].focused).toBe(1)
  })

  it('dispatch writes a JSON command line and resolves on the correlated stdout reply', async () => {
    host.open(input())
    const p = host.dispatchToProcess(input(), 'ping', [])
    const sent = JSON.parse(spawner.handles[0].written[0]) as { requestId: string; cmd: string; args: unknown[] }
    expect(sent.cmd).toBe('ping')
    spawner.handles[0].emitStdout(JSON.stringify({ requestId: sent.requestId, ok: true, result: { pong: true } }) + '\n')
    await expect(p).resolves.toEqual({ ok: true, result: { pong: true } })
  })

  it('buffers partial stdout lines and ignores non-JSON noise', async () => {
    host.open(input())
    const p = host.dispatchToProcess(input(), 'echo', ['hi'])
    const rid = (JSON.parse(spawner.handles[0].written[0]) as { requestId: string }).requestId
    spawner.handles[0].emitStdout('not json\n')
    spawner.handles[0].emitStdout('{"requestId":"' + rid + '",')
    spawner.handles[0].emitStdout('"ok":true,"result":"hi"}\n')
    await expect(p).resolves.toEqual({ ok: true, result: 'hi' })
  })

  it('dispatch to a never-opened process returns process-exited (no auto-spawn)', async () => {
    await expect(host.dispatchToProcess(input(), 'ping', [])).resolves.toEqual({
      ok: false,
      reason: 'process-exited',
      hint: 'call mcp__argus__open_panel first'
    })
    expect(spawner.spawned.length).toBe(0)
  })

  it('an in-flight dispatch rejects with process-exited when the process exits', async () => {
    host.open(input())
    const p = host.dispatchToProcess(input(), 'ping', [])
    spawner.handles[0].emitExit(1)
    await expect(p).resolves.toEqual({ ok: false, reason: 'process-exited' })
  })

  it('dispatch times out', async () => {
    host.open(input())
    await expect(host.dispatchToProcess(input(), 'ping', [])).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('stop escalates close-stdin → SIGTERM → SIGKILL', () => {
    vi.useFakeTimers()
    host.open(input())
    host.stop(input())
    expect(spawner.handles[0].killed).toContain('SIGTERM')
    vi.advanceTimersByTime(5000)
    expect(spawner.handles[0].killed).toContain('SIGKILL')
    vi.useRealTimers()
  })

  it('closeCase terminates only matching-case processes', () => {
    host.open(input({ caseSlug: 'CASE-A' }))
    host.open(input({ caseSlug: 'CASE-B', windowId: 'sim2' }))
    host.closeCase('CASE-A')
    expect(spawner.handles[0].killed.length).toBeGreaterThan(0)
    expect(spawner.handles[1].killed.length).toBe(0)
    expect(host.list('CASE-B').length).toBe(1)
  })

  it('exit flips status to exited and fires onChange', () => {
    host.open(input())
    spawner.handles[0].emitExit(0)
    expect(host.list('CASE-A')[0].status).toBe('exited')
    expect(changes).toBeGreaterThan(0)
  })

  it('stop on an exited app dismisses it from list() and fires onChange', () => {
    host.open(input())
    spawner.handles[0].emitExit(0)
    expect(host.list('CASE-A').length).toBe(1)
    const before = changes
    host.stop(input())
    expect(host.list('CASE-A').length).toBe(0)
    expect(changes).toBeGreaterThan(before)
  })

  it('stop on a running app still terminates (existing behavior intact)', () => {
    host.open(input())
    host.stop(input())
    expect(spawner.handles[0].killed).toContain('SIGTERM')
    expect(host.list('CASE-A').length).toBe(1)
    expect(host.list('CASE-A')[0].status).toBe('running')
  })

  it('stop on a running app removes it from list() once it exits (one-press stop)', () => {
    host.open(input())
    host.stop(input())
    expect(host.list('CASE-A').length).toBe(1) // still present while terminating
    spawner.handles[0].emitExit(0)
    expect(host.list('CASE-A').length).toBe(0) // removed — no lingering 'exited' chip
    expect(changes).toBeGreaterThan(0)
  })

  it('an unexpected exit (no stop) leaves a grey exited chip, not removed', () => {
    host.open(input())
    spawner.handles[0].emitExit(1) // crash / self-exit
    expect(host.list('CASE-A').length).toBe(1)
    expect(host.list('CASE-A')[0].status).toBe('exited')
  })
})
