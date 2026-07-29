import { spawn } from 'node:child_process'

export type OneShotRunner = (prompt: string) => Promise<string>

/**
 * Default runner: `claude -p` headless, prompt via stdin (arg-length-safe; distill prompts
 * carry full skill/reference contents). spawn + streamed stdout — never execFile, whose
 * default maxBuffer silently caps stdout at 1MB.
 */
export function claudeRunner(model?: string): OneShotRunner {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])]
      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(out)
        else reject(new Error(`claude exited ${code}: ${err.slice(0, 2000)}`))
      })
      child.stdin.write(prompt)
      child.stdin.end()
    })
}
