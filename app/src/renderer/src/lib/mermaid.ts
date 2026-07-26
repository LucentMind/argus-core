/** Lazy mermaid: the library loads as its own chunk on first diagram (same pattern
 *  as lib/highlight.ts). Re-initialized before every render so diagrams pick up the
 *  active [data-theme] token values. Never throws — parse/render/load failures all
 *  collapse to { ok: false } so callers can fall back to the source code block. */

export type MermaidResult = { ok: true; svg: string } | { ok: false }

let mod: Promise<typeof import('mermaid')> | null = null
let seq = 0

/** Map OEH design tokens (assets/theme.css) onto mermaid's `base` theme. */
function themeVariables(): Record<string, string> {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string): string => s.getPropertyValue(name).trim()
  return {
    background: v('--bg-2'),
    primaryColor: v('--bg-hi'),
    primaryTextColor: v('--ink'),
    primaryBorderColor: v('--hair-2'),
    secondaryColor: v('--bg-over'),
    tertiaryColor: v('--bg-1'),
    lineColor: v('--dim'),
    textColor: v('--ink'),
    fontFamily: s.fontFamily || 'sans-serif'
  }
}

export async function renderMermaid(source: string): Promise<MermaidResult> {
  const id = `argus-mmd-${++seq}`
  try {
    if (!mod) mod = import('mermaid')
    const mermaid = (await mod).default
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      flowchart: { htmlLabels: false },
      themeVariables: themeVariables()
    })
    const { svg } = await mermaid.render(id, source)
    return { ok: true, svg }
  } catch {
    // mermaid can leave its temp render element behind on a parse error
    document.getElementById(`d${id}`)?.remove()
    document.getElementById(id)?.remove()
    return { ok: false }
  }
}
