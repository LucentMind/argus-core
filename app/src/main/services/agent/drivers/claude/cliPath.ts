import path from 'node:path'
import { asarUnpackedPath, isInsideAsar } from '../asar'

/**
 * Resolve the Claude Code native binary to a path that can actually be spawned from a
 * packaged build, or null to leave the SDK's own resolution alone.
 *
 * Why (verified empirically 2026-07-19 against `dist/win-unpacked`, not inferred from types):
 * the SDK resolves its bundled `claude.exe` inside `app.asar`, which cannot be spawned (see
 * `../asar`). The SDK then reports "Claude Code native binary at <path> exists but failed to
 * launch … does not match this system's libc" — a misleading message, since the real errno is
 * ENOENT and the binary is fine. Pointing `pathToClaudeCodeExecutable` at the unpacked twin
 * fixes it.
 *
 * The platform package declares only `files: ["claude.exe"]` — no `main`/`exports` — so the
 * package itself is not resolvable; we resolve its `package.json` and join the binary name.
 *
 * Returns null outside a packaged build so unpackaged runs keep deferring to the SDK: we
 * override only to escape the asar, never to second-guess the SDK's resolution elsewhere.
 */
export function resolveClaudeCliPath(
  resolve: (id: string) => string = require.resolve
): string | null {
  return insideAsar(resolve) ? claudeBinaryPath(resolve) : null
}

/**
 * The bundled Claude binary's spawnable path, regardless of whether we would override the
 * SDK with it. The packaged smoke check spawns this directly (`--version`) — a launch check
 * must not depend on auth state, and asking the binary its version is the whole question.
 * Null when the platform package is not installed.
 */
export function claudeBinaryPath(resolve: (id: string) => string = require.resolve): string | null {
  const manifest = resolveManifest(resolve)
  if (!manifest) return null
  const bin = path.join(
    path.dirname(manifest),
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  )
  return asarUnpackedPath(bin)
}

function resolveManifest(resolve: (id: string) => string): string | null {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  try {
    return resolve(`${pkg}/package.json`)
  } catch {
    return null // not installed — the SDK's own error is more actionable than ours
  }
}

function insideAsar(resolve: (id: string) => string): boolean {
  const manifest = resolveManifest(resolve)
  return manifest !== null && isInsideAsar(manifest)
}

/**
 * Subprocess environment for every Claude CLI spawn, with Claude Code's own auto-memory OFF.
 *
 * The CLI ships a memory subsystem that defaults ON and tells the model to keep memories as
 * files under `~/.claude/projects/<sanitized-cwd>/memory/` (plus a `MEMORY.md` index) written
 * with the Write tool. Inside Argus that is a second memory system competing with the
 * `read_memory`/`write_memory` native tools — and it won, so "remember this" was landing in
 * `~/.claude/...` instead of ARGUS_HOME, invisible to the Memory settings page.
 *
 * Applied at ALL THREE spawn sites (session, headless, probe), not just the session: the other
 * two cannot write (they pass `allowedTools: []`), but auto-memory also READS, which would
 * inject unrelated memories into one-shot prompts and create stray `~/.claude/projects/-tmp/`
 * directories on the user's machine.
 *
 * The env var is the correct lever rather than `autoMemoryEnabled` in settings.json: the CLI
 * reads it BEFORE consulting settings, and the session passes `settingSources: ['project']`,
 * which drops the user-level settings file the flag would live in.
 *
 * The `process.env` spread is load-bearing — the SDK REPLACES the subprocess environment with
 * this value rather than merging it (see `env` in sdk.d.ts), so omitting the spread would strip
 * PATH/HOME and the CLI's credentials.
 */
export function claudeSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
}
