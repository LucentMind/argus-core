export type AuthoringKind = 'skill' | 'reference'

export interface AuthoringRequest {
  kind: AuthoringKind
  /** Skill folder name, or reference file name. Carried into the prompt so generated
   *  frontmatter matches the folder the validator will check it against. */
  name: string
  /** Draft: the human's plain-English description. Improve: the current buffer. */
  text: string
}

export interface AuthoringResult {
  content: string
}
