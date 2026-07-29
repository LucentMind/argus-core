import fs from 'node:fs'
import { loadCorpus } from './corpus'
import { claudeRunner } from './runner'
import { contractResolver } from './replay'
import { runEval } from './run'
import { writeReport } from './report'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const corpus = arg('corpus')
  const out = arg('out')
  if (!corpus || !out) {
    console.error(
      'usage: argus-distill-eval --corpus <bundle.ndjson> --out <dir> [--contract <file>] [--model <id>] [--limit <n>]'
    )
    process.exit(2)
  }
  const contractFile = arg('contract')
  const resolve = contractResolver(contractFile ? fs.readFileSync(contractFile, 'utf8') : null)
  const limit = arg('limit')
  let lines = loadCorpus(corpus)
  if (limit) lines = lines.slice(0, Number(limit))
  const model = arg('model') ?? undefined
  console.error(`replaying ${lines.length} case(s)…`)
  const results = await runEval(lines, claudeRunner(model), claudeRunner(model), resolve)
  const { reportPath } = writeReport(out, results)
  console.error(`report: ${reportPath}`)
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
