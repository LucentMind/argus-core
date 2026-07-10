// Minimal Atlassian Document Format → markdown for ticket evidence (FTS-friendly).
// Coverage is deliberately small (spec: description text, not fidelity); anything
// unknown degrades to its concatenated children so no ticket content is lost.

interface AdfNode {
  type?: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

export function adfToMarkdown(description: unknown): string {
  if (description == null) return ''
  if (typeof description === 'string') return description
  if (typeof description !== 'object') return String(description)
  return blocks((description as AdfNode).content ?? []).trim()
}

function blocks(nodes: AdfNode[]): string {
  return nodes.map(block).filter(Boolean).join('\n\n')
}

function block(n: AdfNode): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content ?? [])
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level ?? 1), 1), 6)
      return `${'#'.repeat(level)} ${inline(n.content ?? [])}`
    }
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${listItem(li)}`).join('\n')
    case 'orderedList':
      return (n.content ?? []).map((li, i) => `${i + 1}. ${listItem(li)}`).join('\n')
    case 'codeBlock': {
      const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : ''
      return `\`\`\`${lang}\n${inline(n.content ?? [])}\n\`\`\``
    }
    case 'blockquote':
      return blocks(n.content ?? [])
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'rule':
      return '---'
    default:
      // unknown block (panel, table, mediaSingle, …): keep the text, drop the chrome
      return n.content ? blocks(n.content) : inline([n])
  }
}

function listItem(li: AdfNode): string {
  return blocks(li.content ?? []).replace(/\n\n/g, '\n  ')
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join('')
}

function inlineNode(n: AdfNode): string {
  if (n.type === 'hardBreak') return '\n'
  if (n.type === 'mention') return String(n.attrs?.text ?? '')
  if (n.type === 'emoji') return String(n.attrs?.shortName ?? '')
  if (typeof n.text === 'string') {
    let t = n.text
    for (const m of n.marks ?? []) {
      if (m.type === 'code') t = `\`${t}\``
      if (m.type === 'strong') t = `**${t}**`
      if (m.type === 'em') t = `_${t}_`
      if (m.type === 'link') t = `[${t}](${String(m.attrs?.href ?? '')})`
    }
    return t
  }
  return n.content ? inline(n.content) : ''
}
