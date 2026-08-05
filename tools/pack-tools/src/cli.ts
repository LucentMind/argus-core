import { parseArgs } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { build } from './build'
import { buildFeed } from './feed'

const USAGE = [
  'argus-pack build --pack <dir> --bin <dir> --platform <os-arch> --out <dir>',
  'argus-pack feed  --pack <dir> --bundles <dir> --base-url <https-url> --out <file>'
].join('\n       ')

async function runBuild(argv: string[]): Promise<number> {
  let values: Record<string, string | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        pack: { type: 'string' },
        bin: { type: 'string' },
        platform: { type: 'string' },
        out: { type: 'string' }
      }
    }) as { values: Record<string, string | undefined> })
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: ${USAGE}`)
    return 2
  }
  const missing = ['pack', 'bin', 'platform', 'out'].filter((k) => !values[k])
  if (missing.length) {
    console.error(`missing required flag(s): ${missing.join(', ')}\nusage: ${USAGE}`)
    return 2
  }
  try {
    const res = await build({
      packDir: values.pack!,
      binDir: values.bin!,
      platform: values.platform!,
      outDir: values.out!
    })
    for (const w of res.warnings) console.warn(`warning: ${w}`)
    console.log(
      `built ${res.bundleName} (${res.files.length} files, ${Math.round(res.totalBytes / 1024)} KB) → ${res.zipPath}`
    )
    return 0
  } catch (err) {
    console.error(`build failed: ${(err as Error).message}`)
    return 1
  }
}

async function runFeed(argv: string[]): Promise<number> {
  let values: Record<string, string | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        pack: { type: 'string' },
        bundles: { type: 'string' },
        'base-url': { type: 'string' },
        out: { type: 'string' }
      }
    }) as { values: Record<string, string | undefined> })
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: ${USAGE}`)
    return 2
  }
  const missing = ['pack', 'bundles', 'base-url', 'out'].filter((k) => !values[k])
  if (missing.length) {
    console.error(`missing required flag(s): ${missing.join(', ')}\nusage: ${USAGE}`)
    return 2
  }
  try {
    const dir = values.bundles!
    const bundles = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.zip'))
      .map((n) => path.join(dir, n))
    const feed = await buildFeed({ packDir: values.pack!, bundles, baseUrl: values['base-url']! })
    fs.mkdirSync(path.dirname(values.out!), { recursive: true })
    fs.writeFileSync(values.out!, JSON.stringify(feed, null, 2) + '\n', 'utf8')
    console.log(`wrote feed for ${feed.id} (${feed.versions.length} versions) → ${values.out}`)
    return 0
  } catch (err) {
    console.error(`feed failed: ${(err as Error).message}`)
    return 1
  }
}

export async function run(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case 'build':
      return runBuild(argv.slice(1))
    case 'feed':
      return runFeed(argv.slice(1))
    default:
      console.error(`unknown command '${argv[0] ?? ''}'\nusage: ${USAGE}`)
      return 2
  }
}

// `bin` entrypoint: run when executed directly.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
