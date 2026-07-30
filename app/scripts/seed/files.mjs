import fs from 'node:fs'
import path from 'node:path'
import yazl from 'yazl'

/** Sentinel for "write a real zip archive at this path" — the content cannot be an
 *  inline Buffer because building the zip is streaming and therefore async. */
export const ARCHIVE = Symbol('archive')

/** A 1x1 transparent PNG — the smallest thing type detection will call a screenshot. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function appLog() {
  const lines = []
  for (let i = 0; i < 2400; i++) {
    const level = i % 97 === 0 ? 'ERROR' : i % 13 === 0 ? 'WARN' : 'INFO'
    lines.push(
      `2026-07-28T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z ${level} tile-service req=${1000 + i} burst=${i % 20} latency_ms=${40 + (i % 300)}`
    )
  }
  lines.push('2026-07-28T11:00:00Z ERROR tile-service cold-boot timeout after 30000ms cache=empty')
  return lines.join('\n')
}

/**
 * Evidence is investigation material, artifacts are review material — the
 * directory IS the scope (see src/shared/evidenceScope.ts), so the two maps must
 * never share a path.
 */
export function buildTrees(slug) {
  if (slug !== 'HMT-1-burst-token') {
    return {
      evidence: {
        'notes.md': `# ${slug}\n\nThin fixture case.\n`
      },
      artifacts: {
        'ci/summary.log': `check summary for ${slug}\nall steps recorded\n`,
        'review-report.md': `# Review report — ${slug}\n\nTwo findings recorded.\n`
      }
    }
  }
  return {
    evidence: {
      'app.log': appLog(),
      'screenshot.png': Buffer.from(PNG_BASE64, 'base64'),
      'config.json': JSON.stringify({ limit: 100, burst: 20, windowMs: 60000 }, null, 2),
      'timings.csv': 'request,latency_ms,burst\n1,42,0\n2,510,1\n3,38,0\n',
      // A REAL zip. The auto-extract trigger reads it with yauzl, so a gzip stream
      // under a .zip name would fail extraction and leave the case in a state worse
      // than having no archive at all.
      'logs.zip': ARCHIVE
    },
    artifacts: {
      'ci/verify-b.log':
        'verify-b\n> node --test\nFAIL src/__tests__/rateLimiter.test.js\n  burst allowance applies to flood clients\nexit status 1\n',
      'ci/unit-tests.log': 'unit-tests\n> node --test\nPASS 14 tests\nexit status 0\n',
      'ci/lint.log': 'lint\n> eslint .\nclean\nexit status 0\n',
      'diff.patch':
        '--- a/src/rateLimiter.js\n+++ b/src/rateLimiter.js\n@@\n-  if (count > limit) return false\n+  if (count > limit + burst) return false\n',
      'review-report.md':
        '# Review report — pull request 4\n\n- security: legacy token compared without constant time\n- correctness: burst applies to every client\n- tests: no coverage for the burst window\n'
    }
  }
}

/** A real zip with two entries, so the auto-extract path produces two per-file
 *  evidence items rather than erroring on a malformed archive. */
function writeArchive(dest) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    zip.addBuffer(
      Buffer.from('2026-07-28T09:00:00Z INFO archived tile request\n'.repeat(200)),
      'archived/tile.log'
    )
    zip.addBuffer(
      Buffer.from('2026-07-28T09:30:00Z WARN archived auth retry\n'.repeat(50)),
      'archived/auth.log'
    )
    const out = fs.createWriteStream(dest)
    out.on('close', resolve)
    out.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(out)
    zip.end()
  })
}

export async function seedFiles(ctx) {
  const counts = {}
  for (const slug of ctx.SLUGS) {
    const trees = buildTrees(slug)
    const dir = ctx.caseDir(slug)
    let evidence = 0
    let artifacts = 0
    for (const [rel, content] of Object.entries(trees.evidence)) {
      const dest = path.join(dir, 'evidence', rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (content === ARCHIVE) await writeArchive(dest)
      else fs.writeFileSync(dest, content)
      evidence++
    }
    for (const [rel, content] of Object.entries(trees.artifacts)) {
      const dest = path.join(dir, 'artifacts', rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content)
      artifacts++
    }
    counts[slug] = { evidence, artifacts }
  }
  return counts
}
