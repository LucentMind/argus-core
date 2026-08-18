import fs from 'node:fs'
import { loadCorpus } from './corpus'
import { claudeRunner } from './runner'
import { claudeAgentRunner } from './agentRunner'
import { contractResolver } from './replay'
import { runEval, type EvalPipeline } from './run'
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
      'usage: argus-distill-eval --corpus <bundle.ndjson> --out <dir> [--pipeline v2|v3] [--contract <file>] [--model <id>] [--limit <n>]'
    )
    process.exit(2)
  }
  const pipeline = (arg('pipeline') ?? 'v2') as EvalPipeline
  if (pipeline !== 'v2' && pipeline !== 'v3') {
    console.error(`--pipeline must be v2 or v3, got: ${pipeline}`)
    process.exit(2)
  }
  const contractFile = arg('contract')
  // `contractResolver` overrides the v2 contract id and THROWS on any id it doesn't know — and
  // every v3 stage prompt id (`headless.case-distill.dossier.contract`, …) is unknown to it. So
  // the combination is rejected up front rather than blowing up mid-hash with "unknown prompt
  // id"; a v3 prompt experiment means editing the stage file in the working tree.
  if (contractFile && pipeline === 'v3') {
    console.error(
      '--contract overrides the v2 contract only; it is not supported with --pipeline v3'
    )
    process.exit(2)
  }
  const resolve = contractResolver(contractFile ? fs.readFileSync(contractFile, 'utf8') : null)
  const limit = arg('limit')
  if (limit !== null && !Number.isFinite(Number(limit))) {
    console.error(`--limit must be a finite number, got: ${limit}`)
    process.exit(2)
  }
  let lines = loadCorpus(corpus)
  if (limit) lines = lines.slice(0, Number(limit))
  const model = arg('model') ?? undefined
  console.error(`replaying ${lines.length} case(s) through the ${pipeline} distiller…`)
  const results = await runEval(
    lines,
    // agent: the distill replay itself (tools over the frozen world) — v3 uses it for stage 1
    // only. oneShot: the judge, and v3's tool-less stages 2a/2b/3.
    { agent: claudeAgentRunner(model), oneShot: claudeRunner(model) },
    resolve,
    pipeline
  )
  const { reportPath } = writeReport(out, results)
  console.error(`report: ${reportPath}`)
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
