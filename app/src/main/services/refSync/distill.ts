import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CreateQueryFn } from '../agent/session'

export interface DistillPage {
  title: string
  url: string
  markdown: string
  pageId: string
  version: number
}
export interface DistillInput {
  target: string
  currentBody: string | null
  pages: DistillPage[]
}
export interface DistillOptions {
  model?: string
  cliPath?: string
  timeoutMs?: number
}

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

/** The old /bootstrap-references / /refresh-references contract (references/confluence-pages.md). */
export const DISTILL_CONTRACT = `You are distilling Confluence pages into a local reference file for an RCA (root-cause-analysis) toolkit. Reference files carry durable system behavior: how components work, what signals mean, how to operate the system.

Rules — follow every one:
1. DISTILL, do not transcribe. Extract durable facts; drop page boilerplate, marketing, and chatter.
2. Keep SIGNAL PATTERNS VERBATIM: log tags, error strings, regexes, IDs, config keys, file paths and CLI commands must be copied exactly, in code spans or fenced blocks.
3. Cite sources per section: end each H2 section with a line "> Source: [<page title>](<page url>)" for the page(s) it came from.
4. OUT OF SCOPE — skip content dominated by: postmortems / incident timelines, case-specific RCA tied to one ticket or trace, meeting notes / retrospectives / planning docs, one-off experiments. Generic lessons from such docs may land as plain system facts, never as incident narrative. If a page is borderline, prefer skipping and list it under "## Dangling links" with the note "out-of-scope: <category>".
5. DANGLING LINKS: when a source page references links you cannot resolve from the given material (restricted pages, attachments, external dashboards), append a "## Dangling links" section listing each as "- <anchor text> — <URL> — *<why unreadable>* — source: <page title>". Merge with an existing section; omit it when empty. Never silently drop such links.
6. If a current body is provided, MERGE: update the sections the source pages cover, keep unrelated existing sections intact.
7. Output the COMPLETE new body of the reference file as markdown. No YAML frontmatter, no commentary, no code fence around the whole file. Start directly with the H1 title line, followed by a one-sentence overview paragraph (it seeds the references index).`

export function buildDistillPrompt(input: DistillInput): string {
  const pages = input.pages
    .map((p) => `## Source page: ${p.title}\nURL: ${p.url}\n\n${p.markdown}`)
    .join('\n\n---\n\n')
  return [
    DISTILL_CONTRACT,
    `# Target file: ${input.target}`,
    `# Current body\n\n${input.currentBody ?? '(file does not exist yet)'}`,
    `# Source pages\n\n${pages}`,
    `Return ONLY the complete updated body of ${input.target} as markdown.`
  ].join('\n\n')
}

// One message, then hold the stream open — the CLI only emits after the prompt
// stream yields (probe.ts idiom); interrupt() in finally tears the process down.
async function* oneMessage(text: string): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  }
  await new Promise(() => undefined)
}

/**
 * Headless one-shot session mechanics (spec §3.4): no case, no sessions row,
 * no mirror, no tools. A single prompt message, held-open stream, timeout
 * race, and interrupt-in-finally teardown. Throws on failure.
 */
export async function runOneShot(
  promptText: string,
  opts: DistillOptions = {},
  createQuery: CreateQueryFn = defaultCreateQuery
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  let q: ReturnType<CreateQueryFn> | null = null
  try {
    q = createQuery({
      prompt: oneMessage(promptText),
      options: {
        maxTurns: 1,
        allowedTools: [],
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.cliPath ? { pathToClaudeCodeExecutable: opts.cliPath } : {})
      }
    })
    const text = await Promise.race([
      collectAssistantText(q),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`distill timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ])
    if (!text.trim()) throw new Error('distill session returned no text')
    return text
  } finally {
    await q?.interrupt().catch(() => undefined)
  }
}

/**
 * Headless one-shot distillation (spec §3.4): no case, no sessions row, no
 * mirror, no tools. Throws on failure — the caller records a per-file failure
 * and other files stay unaffected.
 */
export async function distillTarget(
  input: DistillInput,
  opts: DistillOptions = {},
  createQuery: CreateQueryFn = defaultCreateQuery
): Promise<string> {
  return runOneShot(buildDistillPrompt(input), opts, createQuery)
}

async function collectAssistantText(q: ReturnType<CreateQueryFn>): Promise<string> {
  let last = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const msg of q as AsyncIterable<any>) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const t = msg.message.content
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: unknown }) => String(b.text ?? ''))
        .join('')
      if (t.trim()) last = t
    }
    if (msg?.type === 'result') {
      if (msg.subtype && msg.subtype !== 'success') {
        throw new Error(`distill session failed: ${String(msg.subtype)}`)
      }
      break
    }
  }
  return last
}
