import type { PromptTextSpecs } from '../../shared/promptSpec'
import type { TreeHeadings } from '../../shared/findingTree'

/**
 * The three headings of the finding tree, read by the agent (`list_findings`) and by the
 * headless readers (distill v2, the v3 dossier, the RCA drafter) through `renderFindingTree`.
 * Registered under the `tool-feedback.list_findings.*` ids they had when they lived in
 * `nativeTools.ts`'s `TOOL_FEEDBACK`, so an existing override keeps working; they moved here so
 * a prompt builder can resolve them without importing the tool module.
 */
export const FINDING_TREE_HEADINGS: PromptTextSpecs = {
  'list_findings.root-cause': {
    title: 'finding tree — ROOT CAUSE heading',
    text: 'ROOT CAUSE (each ↳ line is caused by the nearest less-indented line above it)'
  },
  'list_findings.unexplained': {
    title: 'finding tree — UNEXPLAINED heading',
    text: 'UNEXPLAINED (no recorded cause — the chain stops here)'
  },
  'list_findings.ruled-out': {
    title: 'finding tree — RULED OUT heading',
    text: 'RULED OUT'
  }
}

/** The headings as `renderFindingTree` takes them, resolved through the prompt store when a
 *  resolver is given (an override bites on the next call), the shipped text otherwise. */
export function treeHeadings(resolve?: (id: string) => string): TreeHeadings {
  const t = (key: string): string =>
    resolve ? resolve(`tool-feedback.${key}`) : FINDING_TREE_HEADINGS[key].text
  return {
    rootCause: t('list_findings.root-cause'),
    unexplained: t('list_findings.unexplained'),
    ruledOut: t('list_findings.ruled-out')
  }
}
