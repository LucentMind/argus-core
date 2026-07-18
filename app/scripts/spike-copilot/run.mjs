// Runner for the Copilot SDK spike. Executes scenario modules sequentially so
// they never contend for the runtime, printing a one-line PASS/FAIL per module.
// Usage:
//   node scripts/spike-copilot/run.mjs            # all scenarios
//   node scripts/spike-copilot/run.mjs 09 12 99   # only matching prefixes
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenariosDir = path.join(here, 'scenarios')
const filter = process.argv.slice(2)

const files = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .filter((f) => filter.length === 0 || filter.some((p) => f.startsWith(p)))

const results = []
for (const file of files) {
  const started = Date.now()
  process.stdout.write(`\n=== ${file} ===\n`)
  try {
    const mod = await import(pathToFileURL(path.join(scenariosDir, file)).href)
    await mod.default()
    const ms = Date.now() - started
    results.push({ file, ok: true, ms })
    process.stdout.write(`--- ${file} PASS (${ms}ms)\n`)
  } catch (err) {
    const ms = Date.now() - started
    results.push({ file, ok: false, ms, error: String(err?.message ?? err) })
    process.stdout.write(`--- ${file} FAIL (${ms}ms): ${String(err?.message ?? err)}\n`)
  }
}

process.stdout.write('\n===== SUMMARY =====\n')
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  ${r.ms}ms${r.error ? '  ' + r.error : ''}\n`)
}
process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} scenarios completed without throwing.\n`)
// Never hard-fail the process: a thrown scenario still leaves partial fixtures,
// and captured in-fixture errors are themselves evidence.
process.exit(0)
