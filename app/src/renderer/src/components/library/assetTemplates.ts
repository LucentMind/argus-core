/**
 * Starting text for a new asset. A plain `.ts` module because
 * `react-refresh/only-export-components` forbids a component file exporting anything but the
 * component and types — which is why these had eslint-disable comments while they lived in
 * `AssetEditor.tsx`. Those comments go away with the move.
 */
export function skillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Use when … (name the situation, the artifacts involved, and the words a user would say)',
    '# roles: [triage, review]   # optional — omit to apply in both modes',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    '## Method',
    '',
    '1. ',
    ''
  ].join('\n')
}

export function referenceTemplate(name: string): string {
  const title = name.replace(/\.md$/, '').replace(/[-_]/g, ' ')
  return [
    `# ${title}`,
    '',
    'One-sentence overview — this seeds the references index.',
    '',
    '## ',
    ''
  ].join('\n')
}
