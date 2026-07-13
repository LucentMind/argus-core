import { spawn } from 'node:child_process'
import type { ProcessHandle, ProcessSpawner } from './externalAppHost'

export function createElectronProcessSpawner(): ProcessSpawner {
  return {
    spawn(cmd, args, opts): ProcessHandle {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      // Swallow async stream errors (e.g. EPIPE from a broken-pipe write after the
      // child dies mid-dispatch) — without a listener these become unhandled 'error'
      // events on the stream and crash the whole main process.
      child.stdin?.on('error', () => {})
      child.stdout?.on('error', () => {})
      child.stderr?.on('error', () => {})
      return {
        pid: child.pid ?? -1,
        writeLine(line) {
          const stdin = child.stdin
          if (!stdin || stdin.destroyed || stdin.writableEnded) return
          stdin.write(line.endsWith('\n') ? line : line + '\n')
        },
        onStdoutLine(cb) {
          child.stdout?.on('data', (chunk: string) => cb(chunk))
        },
        onStderr(cb) {
          child.stderr?.on('data', (chunk: string) => cb(chunk))
        },
        onExit(cb) {
          child.on('exit', (code) => cb(code))
          child.on('error', () => cb(null))
        },
        kill(signal) {
          if (signal === 'SIGTERM') child.stdin?.end()
          child.kill(signal)
        },
        focus() {
          // Best-effort: Core does not own the child's OS window. The window appears
          // focused on spawn (OS default); re-raising an existing window is a no-op here.
        }
      }
    }
  }
}
