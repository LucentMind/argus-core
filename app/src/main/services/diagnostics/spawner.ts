import { spawn } from 'node:child_process'

/**
 * Narrow spawn seam for the diagnostics sidecar.
 *
 * Intentionally separate from panels/externalAppHost's ProcessSpawner: that one
 * carries cwd and focus() for pack apps, neither of which applies here. Keeping
 * them apart avoids coupling two unrelated subsystems through one interface.
 */
export interface SidecarProcess {
  readonly pid: number
  writeLine(line: string): void
  onStdoutChunk(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface SidecarSpawner {
  spawn(cmd: string): SidecarProcess
}

export function createElectronSidecarSpawner(): SidecarSpawner {
  return {
    spawn(cmd: string): SidecarProcess {
      const child = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      // Without these listeners an EPIPE from writing to a dead child becomes an
      // unhandled 'error' event and crashes the whole main process.
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
        onStdoutChunk: (cb) => child.stdout?.on('data', (c: string) => cb(c)),
        onStderr: (cb) => child.stderr?.on('data', (c: string) => cb(c)),
        onExit: (cb) => {
          child.on('exit', (code) => cb(code))
          child.on('error', () => cb(null))
        },
        kill: () => {
          child.stdin?.end()
          child.kill()
        }
      }
    }
  }
}
