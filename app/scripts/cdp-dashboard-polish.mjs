#!/usr/bin/env node
/**
 * CDP acceptance for the dashboard/chrome polish round
 * (spec 2026-08-01-dashboard-polish-design.md).
 *
 * Every claim in that spec is a *computed style* claim — equal control heights, a card floor 15%
 * lower, even header spacing, a masthead that stays one line. jsdom loads no stylesheet and
 * resolves no cascade, so the unit suite proves the markup and nothing about the layout. This
 * drives the real app and measures the rendered boxes.
 *
 * Usage:
 *   1. Boot against an isolated home that already has the fixture:
 *        ARGUS_HOME=<home> npx electron-vite dev --remoteDebuggingPort 9231
 *        ARGUS_HOME=<home> node scripts/dashboard-polish-fixture.mjs
 *   2. node scripts/cdp-dashboard-polish.mjs
 *
 * Env: CDP_PORT (default 9231).
 * Exits 0 when every check passes, 1 otherwise.
 *
 * Tailwind trap (see the HMR note in the repo's notes): a class that did not exist before this
 * change gets no CSS emitted under an HMR update — the dev server must have been (re)started
 * after the source edit, or every measurement here reads the pre-change stylesheet and lies.
 * `min-h-[158px]` is new, so check 5 doubles as the canary: if it reports the old 186 floor with
 * the source clearly saying 158, restart the dev server rather than "fixing" the component.
 */
import { listTargets as list, connect, mainWindow, sleep, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9231'

const conn = await connect(mainWindow(await list(PORT)))

/** Re-read the case list from main, then let React paint. */
async function reload() {
  await conn.send('Page.reload', { ignoreCache: true })
  await sleep(3500)
}

await reload()

// ── 0. am I even talking to the right app? ─────────────────────────────────────────────────
//
// Learned the hard way: `electron-vite dev --remoteDebuggingPort N` does not fail loudly when N
// is already bound — it logs one `bind() returned an error` line among hundreds of GPU-cache
// warnings and carries on with no debug port at all. This gate then connects to whichever OTHER
// Argus dev instance owns that port and cheerfully measures it. Several people run more than one
// worktree at a time, so that is the normal case, not a freak one. Refuse to report anything
// until the fixture's own cases are on screen.

const identity = await conn.evalJs(`(() => {
  const slugs = [...document.querySelectorAll('[data-testid="case-title"]')]
    .map((t) => t.closest('div[class*="rounded-r3"], .glass-card').querySelector('.font-mono').textContent.trim())
  return { slugs, url: location.href }
})()`)

if (!identity.slugs.includes('NAV-101-heading-drift')) {
  console.error(
    `\nWRONG APP on port ${PORT}. Expected this gate's fixture; found ${JSON.stringify(identity.slugs)}.\n` +
      `Another Argus instance almost certainly owns the port — grep the dev log for "bind() returned an error",\n` +
      `pick a free port, and relaunch. Measuring on regardless would report another branch's UI as this one's.`
  )
  process.exit(2)
}
console.error(`connected to the fixture home (${identity.slugs.length} cases)\n`)

// ── 1. one brand mark, inside the home button ──────────────────────────────────────────────

const brand = await conn.evalJs(`(() => {
  const marks = [...document.querySelectorAll('*')].filter(
    (el) => el.children.length === 0 && el.textContent.trim() === 'ARGUS'
  )
  const home = document.querySelector('button[aria-label="All cases"]')
  return {
    count: marks.length,
    insideHome: marks.length === 1 && home ? home.contains(marks[0]) : false,
    homeBox: home ? home.getBoundingClientRect().toJSON() : null
  }
})()`)

check('exactly one ARGUS wordmark in the window', brand.count === 1, `found ${brand.count}`)
check('the wordmark sits inside the home button', brand.insideHome === true)
check(
  'the brand box is top-left',
  brand.homeBox && brand.homeBox.left < 24 && brand.homeBox.top < 24,
  JSON.stringify(brand.homeBox)
)

// ── 2. greeting, not a wordmark, on home ───────────────────────────────────────────────────

const greeting = await conn.evalJs(`(() => {
  const h1 = document.querySelector('h1')
  return { text: h1 ? h1.textContent.trim() : null, font: h1 ? getComputedStyle(h1).fontFamily : null }
})()`)

check(
  'home masthead greets by time of day',
  /^Good (morning|afternoon|evening)(, .+)?$/.test(greeting.text || ''),
  JSON.stringify(greeting.text)
)
check(
  'the greeting is set in the sans face, not the wordmark face',
  greeting.font != null && !/Michroma/i.test(greeting.font),
  greeting.font
)

// ── 3. filter row: one height, one style, Show closed rightmost ────────────────────────────

const row = await conn.evalJs(`(() => {
  const input = document.querySelector('input[placeholder="Search cases…"]')
  const bar = input.closest('div').parentElement
  const controls = [...bar.querySelectorAll('input[placeholder], button')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({
      label: el.tagName === 'INPUT' ? 'search' : el.textContent.trim().slice(0, 12),
      h: Math.round(el.getBoundingClientRect().height),
      border: getComputedStyle(el).borderTopColor,
      radius: getComputedStyle(el).borderTopLeftRadius
    }))
  const closed = bar.querySelector('input[aria-label="Show closed cases"]').closest('label')
  return {
    controls,
    barRight: Math.round(bar.getBoundingClientRect().right),
    closedRight: Math.round(closed.getBoundingClientRect().right),
    closedLeft: Math.round(closed.getBoundingClientRect().left),
    syncRight: Math.round(
      [...bar.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Sync all'))
        .getBoundingClientRect().right
    ),
    divider: bar.querySelector('.w-px') !== null
  }
})()`)

const heights = [...new Set(row.controls.map((c) => c.h))]
check(
  'every filter control is the same height',
  heights.length === 1,
  JSON.stringify(row.controls.map((c) => `${c.label}:${c.h}`))
)
const radii = [...new Set(row.controls.map((c) => c.radius))]
const borders = [...new Set(row.controls.map((c) => c.border))]
check('every filter control shares one corner radius', radii.length === 1, JSON.stringify(radii))
check(
  'every filter control shares one border colour',
  borders.length === 1,
  JSON.stringify(borders)
)
check(
  'Show closed is the rightmost control in the row',
  row.closedRight > row.syncRight && row.barRight - row.closedRight < 4,
  `closed ends ${row.closedRight}, sync ends ${row.syncRight}, bar ends ${row.barRight}`
)
check('the vertical divider is gone', row.divider === false)

// ── 4. header spacing is even ──────────────────────────────────────────────────────────────

const spacing = await conn.evalJs(`(() => {
  const h1 = document.querySelector('h1')
  const stack = h1.parentElement
  const outer = stack.parentElement.parentElement
  return {
    innerGap: getComputedStyle(stack).rowGap,
    outerGap: getComputedStyle(outer).rowGap,
    rowMarginTop: getComputedStyle(outer.lastElementChild).marginTop
  }
})()`)

check(
  'the header bands share one gap',
  spacing.innerGap === spacing.outerGap,
  `inner ${spacing.innerGap} vs outer ${spacing.outerGap}`
)
check(
  'the filter row carries no extra ad-hoc top margin',
  spacing.rowMarginTop === '0px',
  spacing.rowMarginTop
)

// ── 5. card floor dropped 15%, ticket id is blue ───────────────────────────────────────────

const cards = await conn.evalJs(`(() => {
  const titles = [...document.querySelectorAll('[data-testid="case-title"]')]
  const card = titles[0].closest('div[class*="rounded-r3"], .glass-card')
  const slug = card.querySelector('.font-mono')
  return {
    count: titles.length,
    minHeight: getComputedStyle(card).minHeight,
    height: Math.round(card.getBoundingClientRect().height),
    slugColor: getComputedStyle(slug).color,
    signal: getComputedStyle(document.documentElement).getPropertyValue('--signal').trim()
  }
})()`)

check('the fixture rendered its cards', cards.count >= 7, `${cards.count} cards`)
check(
  'the card floor is 158px — 15% under the old 186',
  cards.minHeight === '158px',
  `${cards.minHeight} (STALE CSS if this says 186px — restart the dev server)`
)
check(
  'the ticket id is blue (--signal), not amber',
  cards.slugColor === 'rgb(126, 196, 255)',
  `${cards.slugColor}, --signal is ${cards.signal}`
)

// ── 6. priority glyphs, with the text fallback for an unmapped scheme ──────────────────────

const prio = await conn.evalJs(`(() => {
  const byCase = {}
  for (const t of document.querySelectorAll('[data-testid="case-title"]')) {
    const card = t.closest('div[class*="rounded-r3"], .glass-card')
    const slug = card.querySelector('.font-mono').textContent.trim()
    const icon = card.querySelector('[data-testid="priority-icon"]')
    const chip = card.querySelector('span[class*="rounded-r1"]')
    byCase[slug] = {
      label: icon ? icon.getAttribute('aria-label') : null,
      color: icon ? getComputedStyle(icon).color : null,
      paths: icon ? icon.querySelectorAll('path, polyline').length : 0,
      chip: chip ? chip.textContent.trim() : null
    }
  }
  return byCase
})()`)

const g = (slug) => prio[slug] || {}
check(
  'Highest renders a glyph labelled with its priority',
  g('NAV-101-heading-drift').label === 'Priority: Highest',
  JSON.stringify(g('NAV-101-heading-drift'))
)
check(
  'the five mapped priorities all render a glyph',
  // Boolean(), not `!== null`: a slug missing from the page yields `{}`, whose `.label` is
  // undefined — and `undefined !== null` is true, so the obvious spelling passes vacuously on
  // exactly the data that should fail it.
  [
    'NAV-101-heading-drift',
    'NAV-102-route-missing',
    'NAV-103-stopover-early',
    'HMT-104-map-tiles',
    'HMT-105-toast-copy'
  ].every((s) => Boolean(g(s).label)),
  JSON.stringify(Object.fromEntries(Object.entries(prio).map(([k, v]) => [k, v.label])))
)
check(
  'severity is carried in colour: Highest red, Medium amber, Lowest blue',
  g('NAV-101-heading-drift').color === 'rgb(242, 122, 107)' &&
    g('NAV-103-stopover-early').color === 'rgb(243, 195, 82)' &&
    g('HMT-105-toast-copy').color === 'rgb(126, 196, 255)',
  `${g('NAV-101-heading-drift').color} / ${g('NAV-103-stopover-early').color} / ${g('HMT-105-toast-copy').color}`
)
check(
  'Highest and High are told apart by the glyph, not the colour',
  g('NAV-101-heading-drift').paths !== g('NAV-102-route-missing').paths &&
    g('NAV-101-heading-drift').color === g('NAV-102-route-missing').color,
  `${g('NAV-101-heading-drift').paths} vs ${g('NAV-102-route-missing').paths} paths`
)
check(
  'an unmapped scheme falls back to the text chip, not to nothing',
  g('HMT-106-burst-token').label === null && g('HMT-106-burst-token').chip === 'Escalated',
  JSON.stringify(g('HMT-106-burst-token'))
)
check(
  'a case with no priority shows neither glyph nor chip',
  g('HMT-107-no-priority').label === null && g('HMT-107-no-priority').chip === null,
  JSON.stringify(g('HMT-107-no-priority'))
)

// ── 7. settings masthead: no wordmark, fixed height across pages ───────────────────────────

const settings = await conn.evalJs(`(() => {
  document.querySelector('button[aria-label="Settings"]').click()
  return true
})()`)
void settings
await sleep(1200)

const masthead = await conn.evalJs(`(() => {
  const blurb = document.querySelector('[data-testid="settings-blurb"]')
  const bar = blurb.closest('div').parentElement.parentElement
  const line = parseFloat(getComputedStyle(blurb).lineHeight)
  return {
    wordmarks: [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === 'ARGUS'
    ).length,
    height: Math.round(bar.getBoundingClientRect().height),
    blurbHeight: Math.round(blurb.getBoundingClientRect().height),
    line: Math.round(line),
    clipped: blurb.scrollWidth > blurb.clientWidth,
    title: blurb.getAttribute('title') === blurb.textContent
  }
})()`)

check(
  'Settings carries no wordmark of its own (the top bar still has the only one)',
  masthead.wordmarks === 1,
  `${masthead.wordmarks} wordmarks on screen`
)
check(
  'the blurb occupies exactly one line',
  masthead.blurbHeight <= masthead.line + 1,
  `${masthead.blurbHeight}px tall, line-height ${masthead.line}px`
)
check('the full blurb stays reachable on hover', masthead.title === true)

// Navigate every page and confirm the masthead never changes height.
const heightsByPage = await conn.evalJs(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const nav = document.querySelector('nav[aria-label="Settings sections"]')
  const out = {}
  for (const b of [...nav.querySelectorAll('button')]) {
    b.click()
    await wait(220)
    const blurb = document.querySelector('[data-testid="settings-blurb"]')
    const bar = blurb.closest('div').parentElement.parentElement
    out[b.textContent.trim()] = Math.round(bar.getBoundingClientRect().height)
  }
  return out
})()`)

const uniqueHeights = [...new Set(Object.values(heightsByPage))]
check(
  'the masthead is the same height on every page',
  uniqueHeights.length === 1,
  JSON.stringify(heightsByPage)
)

report()
