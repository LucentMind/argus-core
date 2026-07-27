/**
 * How a text-owning module declares its model-facing strings.
 *
 * Modules keep their own text (Plan 1's rule: the registry references defaults, it does not
 * own them) but export it as a record of these specs, so `specEntries` in registry.ts can
 * derive one catalog entry per key. Adding a string to the record registers it.
 *
 * This module imports nothing on purpose. registry.ts imports the text-owning modules, so a
 * text-owning module importing the spec type back from registry.ts would be a cycle; and it
 * lives in shared/ because the renderer owns one registered prompt (the onboarding tour) and
 * shared/* may never import from main/*.
 */
export interface PromptTextSpec {
  /** Human label for the catalog row. */
  title: string
  /** The default text. For a template, the form containing every `{placeholder}`. */
  text: string
  /**
   * Names of `{name}` tokens the text carries. Declaring them is what makes the entry safe to
   * override: `PromptStore.setOverride` refuses an override that drops one, because the value
   * the token carried would silently vanish from the message.
   */
  placeholders?: readonly string[]
}

export type PromptTextSpecs = Readonly<Record<string, PromptTextSpec>>
