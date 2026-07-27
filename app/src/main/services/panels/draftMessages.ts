import type { PromptTextSpecs } from '../../../shared/promptSpec'

/**
 * Messages Argus synthesizes on a panel's behalf and stages in the chat composer as an
 * editable draft (never auto-sent — see 3b-1's `sendToAgent` decision).
 *
 * This text used to be inline in `main/index.ts`, which the prompt coverage scanner cannot
 * read: it is a ~1700-line bootstrap file whose non-prompt literals would need a large,
 * constantly-churning allowlist. Keeping the string in a small module the scanner does read is
 * what lets the guard cover it.
 */
export const PANEL_DRAFTS: PromptTextSpecs = {
  'panel-capture': {
    title: 'Panel capture — composer draft',
    text: 'I captured this from a panel and saved it as {relPath} — use Read on that path to view the image.',
    placeholders: ['relPath']
  }
}
