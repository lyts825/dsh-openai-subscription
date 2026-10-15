import type { QuotaBucket, QuotaWindow, ResetCredit, UsageView } from './shared.ts'

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function windowView(value: unknown): QuotaWindow | null {
  const item = record(value)
  if (!item || (item.windowDurationMins !== 300 && item.windowDurationMins !== 10080)) return null
  if (typeof item.usedPercent !== 'number' || !Number.isFinite(item.usedPercent)) return null
  const usedPercent = Math.min(100, Math.max(0, item.usedPercent))
  return {
    durationMins: item.windowDurationMins,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: timestamp(item.resetsAt),
  }
}

/** Parse a complete read snapshot. Rolling notifications must trigger a fresh read. */
export function parseUsage(value: unknown, now = Date.now()): UsageView {
  const response = record(value)
  if (!response || !record(response.rateLimits)) throw new Error('Codex 返回了无法识别的额度数据')
  const byId = record(response.rateLimitsByLimitId)
  const entries = byId === null ? [['codex', response.rateLimits] as const] : Object.entries(byId)
  const buckets: QuotaBucket[] = []
  for (const [key, raw] of entries) {
    const item = record(raw)
    if (!item) continue
    const windows = [windowView(item.primary), windowView(item.secondary)]
      .filter((window): window is QuotaWindow => window !== null)
      .filter((window, index, all) => all.findIndex(other => other.durationMins === window.durationMins) === index)
      .sort((left, right) => left.durationMins - right.durationMins)
    if (!windows.length) continue
    const id = typeof item.limitId === 'string' && item.limitId ? item.limitId : key
    buckets.push({ id, name: typeof item.limitName === 'string' && item.limitName ? item.limitName : id, windows })
  }
  let resetCredits: UsageView['resetCredits'] = null
  const summary = record(response.rateLimitResetCredits)
  if (summary && typeof summary.availableCount === 'number' && Number.isSafeInteger(summary.availableCount) && summary.availableCount >= 0) {
    let credits: ResetCredit[] | null = null
    if (Array.isArray(summary.credits)) {
      credits = summary.credits.flatMap((raw): ResetCredit[] => {
        const item = record(raw)
        if (!item || typeof item.id !== 'string' || !item.id || item.status !== 'available' || item.resetType !== 'codexRateLimits') return []
        const expiresAt = timestamp(item.expiresAt)
        if (expiresAt !== null && expiresAt * 1000 <= now) return []
        return [{ id: item.id, title: typeof item.title === 'string' ? item.title : null, expiresAt }]
      })
    }
    resetCredits = { availableCount: summary.availableCount, credits }
  }
  return { buckets, resetCredits, updatedAt: now }
}

export function usageAccountId(value: unknown): string | null {
  const id = record(value)?.accountId
  return typeof id === 'string' && id ? id : null
}
