#!/usr/bin/env node
/**
 * Task 13 pixel verification: AmbientCanvas must composite OVER --wash in light (alpha ramp),
 * not paint an opaque flat rectangle on top of it, and dark must be pixel-identical to before.
 * Ad-hoc verification script for this fix — follows cdp-dynamic-theme-views.mjs's pattern
 * (1x1 clip screenshots, decoded by hand) rather than reasoning about the shader from source.
 *
 * Usage: ARGUS_HOME=<scratch home> CDP_PORT=9334 node scripts/cdp-task13-ambient-wash.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { listTargets as list, connect, mainWindow, sleep, waitFor } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9334'
const OUT = path.resolve(process.env.OUT || './task13-shots')
fs.mkdirSync(OUT, { recursive: true })
const listTargets = () => list(PORT)

async function sendOk(conn, method, params) {
  const r = await conn.send(method, params)
  if (r.error) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`)
  return r.result
}
async function setViewport(conn, width, height) {
  await sendOk(conn, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
}

function decode1x1Png(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idatChunks = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 8 + len + 4
  }
  if (width !== 1 || height !== 1) throw new Error(`expected 1x1, got ${width}x${height}`)
  const raw = zlib.inflateSync(Buffer.concat(idatChunks))
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colorType ${colorType}`)
  return [raw[1], raw[2], raw[3]]
}

async function screenshotPixel(conn, x, y) {
  const r = await sendOk(conn, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: 1, height: 1, scale: 1 },
    fromSurface: true
  })
  return decode1x1Png(Buffer.from(r.data, 'base64'))
}

async function shot(conn, name) {
  const r = await sendOk(conn, 'Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.error(`  shot: ${file}`)
  return file
}

const clickSelector = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

const clickByLabel = (conn, containerSel, label) =>
  conn.evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(containerSel)})
    if (!root) return false
    const btn = [...root.querySelectorAll('button')].find(
      b => (b.textContent || '').trim().startsWith(${JSON.stringify(label)})
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)

const gotoHome = async (conn) => {
  await clickSelector(conn, 'button[aria-label="All cases"]')
  await waitFor('home view', () =>
    conn.evalJs(
      `!!document.querySelector('[data-testid="dynamic-home"], .flex.min-h-0.flex-1.flex-col.overflow-y-auto')`
    )
  )
}

const openSettings = async (conn) => {
  if (await conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)) return
  await clickSelector(conn, 'button[aria-label="Settings"]')
  await waitFor('settings view', () =>
    conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)
  )
}

async function setDynamicTheme(conn, on) {
  await openSettings(conn)
  await clickByLabel(conn, 'nav[aria-label="Settings sections"]', 'General')
  await waitFor('General settings page', () =>
    conn.evalJs(`!!document.querySelector('button[aria-label="Dynamic theme"]')`)
  )
  const current = await conn.evalJs(
    `document.querySelector('button[aria-label="Dynamic theme"]').getAttribute('aria-checked') === 'true'`
  )
  if (current !== on) {
    await clickSelector(conn, 'button[aria-label="Dynamic theme"]')
    await sleep(250)
  }
}

async function setTheme(conn, theme) {
  const current = await conn.evalJs(`document.documentElement.getAttribute('data-theme')`)
  if (current === theme) return
  await clickSelector(conn, 'button[aria-label^="Switch to"]')
  await waitFor(`theme => ${theme}`, () =>
    conn.evalJs(`document.documentElement.getAttribute('data-theme') === ${JSON.stringify(theme)}`)
  )
}

const rect = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })()`)

async function main() {
  const targets = await listTargets()
  if (targets.length === 0) throw new Error(`no page target on CDP port ${PORT}`)
  const conn = await connect(mainWindow(targets) ?? targets[0])
  await setViewport(conn, 1440, 900)
  await gotoHome(conn)
  await setDynamicTheme(conn, true)
  await gotoHome(conn)

  const results = {}

  for (const theme of ['light', 'dark']) {
    await setTheme(conn, theme)
    await gotoHome(conn)
    await sleep(700) // let the ambient effect run its first refresh() + a few rAF frames

    const canvasRect = await rect(conn, 'canvas.dyn-ambient')
    if (!canvasRect)
      throw new Error(`[${theme}] no ambient canvas — WebGL2 unavailable? (fallback rendered)`)

    const xs = [
      Math.round(canvasRect.left + canvasRect.width * 0.15),
      Math.round(canvasRect.left + canvasRect.width * 0.5),
      Math.round(canvasRect.left + canvasRect.width * 0.85)
    ]
    const bottomY = Math.round(canvasRect.bottom)

    const seam = []
    for (const x of xs) {
      const above = await screenshotPixel(conn, x, bottomY - 2)
      const below = await screenshotPixel(conn, x, bottomY + 2)
      const d = Math.max(...above.map((v, i) => Math.abs(v - below[i])))
      seam.push({ x, above, below, maxChannelDiff: d })
    }

    // bloom: near top-left where --wash's white radial peaks (4% -6% viewport), vs the same x
    // at the bottom of the canvas — the largest vertical baseline the canvas rect offers.
    const bloomX = Math.round(canvasRect.left + 20)
    const topLeft = await screenshotPixel(conn, bloomX, Math.round(canvasRect.top + 4))
    const midDown = await screenshotPixel(conn, bloomX, Math.round(canvasRect.bottom - 4))
    const topLeftLum = (topLeft[0] + topLeft[1] + topLeft[2]) / 3
    const midDownLum = (midDown[0] + midDown[1] + midDown[2]) / 3

    // Far side of the canvas, well outside the home hero halo's horizontal extent: isolates the
    // WASH's own gradient from the aurora's tint, so a difference here can't be explained away as
    // "the aurora is just brighter near the wordmark."
    const farX = Math.round(canvasRect.left + canvasRect.width - 40)
    const farTop = await screenshotPixel(conn, farX, Math.round(canvasRect.top + 4))
    const farBottom = await screenshotPixel(conn, farX, Math.round(canvasRect.bottom - 4))

    results[theme] = {
      canvasRect,
      seam,
      topLeft,
      midDown,
      topLeftLum,
      midDownLum,
      farTop,
      farBottom
    }
    await shot(conn, `home-${theme}-dynOn`)
  }

  console.log(JSON.stringify(results, null, 2))
  conn.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
