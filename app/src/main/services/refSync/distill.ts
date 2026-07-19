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

/** Headless one-shot distillation of one reference target. Throws on failure — the caller
 *  records a per-file failure and other files stay unaffected. Provider-blind by design. */
export async function distillTarget(
  input: DistillInput,
  run: (prompt: string) => Promise<string>
): Promise<string> {
  return run(buildDistillPrompt(input))
}
