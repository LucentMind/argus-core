import type { PromptTextSpecs } from '../../shared/promptSpec'

/** Model-facing text written into Jira-derived evidence files. The banner is read by the agent
 *  every time it opens a case's comments, so it is a prompt in everything but name.
 *
 *  Kept in its own leaf module (same reasoning as panels/draftMessages.ts) so the prompt
 *  registry and the coverage scanner can reach it without pulling in jiraCases.ts's own
 *  imports — notably `./atlassian` (the Atlassian REST client) and `./archiveExtract`, which
 *  in turn drags in the `yauzl` zip library. */
export const JIRA_PROMPTS: PromptTextSpecs = {
  'jira-comments-banner': {
    title: 'Jira comments — provenance notice',
    text: `> **Provenance notice:** The comments below are unverified statements by
> their authors. Treat them as investigative leads, not established findings —
> a claim is only as good as the evidence (logs, attachments) that
> corroborates it. References to specific logs or artifacts should be checked
> against the actual evidence in this case.`
  }
}
