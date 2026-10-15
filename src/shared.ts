/** Display-only state. OAuth credentials never cross the DSH Connection. */
export interface QuotaWindow {
  durationMins: 300 | 10080
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
}
export interface QuotaBucket {
  id: string
  name: string
  windows: QuotaWindow[]
}
export interface ResetCredit {
  id: string
  title: string | null
  expiresAt: number | null
}
export interface UsageView {
  buckets: QuotaBucket[]
  resetCredits: { availableCount: number; credits: ResetCredit[] | null } | null
  updatedAt: number
}
export interface AccountView {
  email: string | null
  planType: string | null
}
export interface ResetOperation {
  id: string
  creditId: string | null
  expiresAt: number | null
  status: 'prepared' | 'uncertain' | 'completed'
  outcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | null
}
export interface SubscriptionView {
  account: AccountView | null
  usage: UsageView | null
  stale: boolean
  error: string | null
  login: { id: string; url: string } | null
  operation: ResetOperation | null
}
export const RPC_PREFIX = 'openai-subscription/'
export const RPC_CHANNEL = '/api'
export const PROVIDER_ID = 'openai-subscription'
