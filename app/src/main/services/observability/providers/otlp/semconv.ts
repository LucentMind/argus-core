/**
 * The ONE place OTLP attribute / event / operation names live. The GenAI semantic
 * conventions are still Development status (2026-10), so a rename upstream is one
 * edit here. Every name the package exports comes from its `incubating` entry point;
 * only Argus-specific facts (`argus.*`) and the `evaluation` operation value are
 * pinned as literals.
 */
export {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_EVALUATION_NAME,
  ATTR_GEN_AI_EVALUATION_SCORE_VALUE,
  ATTR_GEN_AI_EVALUATION_SCORE_LABEL,
  ATTR_GEN_AI_EVALUATION_EXPLANATION,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT as OP_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT as OP_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL as OP_EXECUTE_TOOL,
  EVENT_GEN_AI_EVALUATION_RESULT
} from '@opentelemetry/semantic-conventions/incubating'

/** Not a conventions operation value; names the short span a rootless score opens. */
export const OP_EVALUATION = 'evaluation'

export const ATTR_ARGUS_CASE_SLUG = 'argus.case.slug'
export const ATTR_ARGUS_COST_USD = 'argus.cost_usd'
export const ATTR_ARGUS_LEVEL = 'argus.level'
export const ATTR_ARGUS_SCORE_ID = 'argus.score.id'
export const ATTR_ARGUS_INSTALL_ID = 'argus.install.id'
