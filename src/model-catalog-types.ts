/** Display-only Codex catalog metadata; membership is not proof of account access. */
export interface CatalogModel {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  inputModalities: ('text' | 'image')[]
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
  defaultReasoningEffort: string | null
  /** Catalog modes that cannot be sent through the current Responses transport. */
  unsupportedReasoningEfforts?: string[]
  /** Preserve an unusable catalog default so callers require an explicit selection. */
  unsupportedDefaultReasoningEffort?: string
  upgrade: string | null
}

export interface ModelCatalogView {
  models: CatalogModel[]
  revision: number
  updatedAt: number | null
  stale: boolean
  refreshing: boolean
  error: string | null
  source: 'codex' | 'unavailable'
  /** model/list does not attest a network fetch or the account's entitlement. */
  remoteVerified: false
}
