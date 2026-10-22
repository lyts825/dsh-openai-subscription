/** Exact DSH adapter route. No API key or credential is accepted here. */
export interface DelegationRoute {
  provider: string
  model: string
  /** Omission preserves DSH's native inherited effort behavior. */
  reasoningEffort?: string
}

export type DelegationTarget = 'ds' | 'gpt'

/** Defaults for new conversations; each conversation captures a durable policy. */
export interface DelegationPolicy {
  enabled: boolean
  mode: 'auto' | 'manual'
  manualTarget: DelegationTarget
  ds: DelegationRoute | null
  gpt: DelegationRoute | null
}

export interface DelegationCandidate extends DelegationRoute {
  target: DelegationTarget
  providerName: string
  modelName: string
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[]
    defaultEffort?: string
  }
}

/** Display metadata only. Catalog membership does not prove login or available quota. */
export interface DelegationView {
  revision: number
  policy: DelegationPolicy
  candidates: DelegationCandidate[]
  catalogFailures: { provider: string; message: string }[]
  available: boolean
  writable: boolean
  error: string | null
}

export function defaultDelegationPolicy(): DelegationPolicy {
  return { enabled: false, mode: 'auto', manualTarget: 'ds', ds: null, gpt: null }
}
