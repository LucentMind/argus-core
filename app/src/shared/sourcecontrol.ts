export interface SourceControlStatus {
  installed: boolean
  version: string | null
  authenticated: boolean
  login: string | null
  detail: string
}
