import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ModelCatalogView } from '../model-catalog-types.ts'
import { localDate } from './format.ts'
import { modelCatalogEn, modelCatalogZh } from './model-catalog-locales.ts'
import { modelCatalogStyles } from './model-catalog-styles.ts'

export interface ModelCatalogCardProps {
  load: (signal: AbortSignal) => Promise<ModelCatalogView>
  refresh: (signal: AbortSignal) => Promise<ModelCatalogView>
  getLocale: () => string
}

/** A catalog browser: it never selects a model or changes a saved route. */
export function ModelCatalogCard({ load, refresh, getLocale }: ModelCatalogCardProps) {
  const [view, setView] = useState<ModelCatalogView | null>(null)
  const [busy, setBusy] = useState<'load' | 'refresh' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const mounted = useRef(false)
  const active = useRef<AbortController | null>(null)
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const locale = getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  const copy = locale === 'zh-CN' ? modelCatalogZh : modelCatalogEn
  const compatibility = locale === 'zh-CN' ? {
    excluded: '已排除当前通道不支持的推理档位',
    unsupportedDefault: (effort: string) => `默认推理档位 ${effort} 与当前通道不兼容，请手动选择支持的档位。`,
    existingUltra: '已有会话若使用 ultra，请在主模型选择器中重新选择支持的推理档位。',
  } : {
    excluded: 'Reasoning levels excluded because this channel does not support them',
    unsupportedDefault: (effort: string) => `The default reasoning level ${effort} is incompatible with this channel. Manually select a supported level.`,
    existingUltra: 'If an existing session uses ultra, choose a supported reasoning level again in the main model selector.',
  }

  const perform = useCallback(async (action: 'load' | 'refresh', fillEmpty = false) => {
    if (!mounted.current || active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(action)
    const current = () => mounted.current && !controller.signal.aborted
    const accept = (next: ModelCatalogView) => {
      if (!current()) return
      setView(next)
      setFailure(null)
    }
    try {
      const next = await (action === 'refresh' ? refresh : load)(controller.signal)
      if (!current()) return
      accept(next)
      // Opening the settings page first reads the cheap state snapshot. Fetch
      // a directory only when there is no list and no sync already in progress.
      if (fillEmpty && next.models.length === 0 && !next.refreshing) {
        setBusy('refresh')
        accept(await refresh(controller.signal))
      }
    } catch (error) {
      if (current()) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (active.current === controller) active.current = null
      if (current()) setBusy(null)
    }
  }, [load, refresh])

  useEffect(() => {
    mounted.current = true
    const visible = () => document.visibilityState === 'visible'
      && root.current !== null && root.current.getClientRects().length > 0
    const sync = () => { if (visible()) void perform('load') }
    void perform('load', true)
    const timer = window.setInterval(sync, 30_000)
    document.addEventListener('visibilitychange', sync)
    return () => {
      mounted.current = false
      active.current?.abort()
      active.current = null
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [perform])

  const models = view?.models ?? []
  const terms = query.trim().normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
  const matches = models.filter(model => {
    const searchable = `${model.displayName} ${model.id}`.normalize('NFKC').toLowerCase()
    return terms.every(term => searchable.includes(term))
  })
  const error = failure ?? view?.error
  const stale = models.length > 0 && Boolean(view?.stale || failure)
  const refreshing = busy === 'refresh' || view?.refreshing === true
  const updated = view?.updatedAt == null ? null : localDate(view.updatedAt, locale)

  return <section className="oa-models" ref={root} aria-labelledby={`${id}-title`} aria-busy={busy !== null || refreshing}>
    <style>{modelCatalogStyles}</style>
    <div className="oa-models-header">
      <h3 id={`${id}-title`}>{copy.title}</h3>
      <button type="button" disabled={busy !== null || refreshing} onClick={() => { void perform('refresh') }}>
        {refreshing ? copy.refreshing : copy.refresh}
      </button>
    </div>
    <p className="oa-models-muted">{copy.intro}</p>
    {!view && busy === 'load' && <p role="status">{copy.loading}</p>}
    <div className="oa-models-meta oa-models-muted">
      <span>{copy.count}: {models.length}</span>
      {view?.source === 'codex' && <span>{copy.source}</span>}
      <span>{updated ? `${copy.updated}: ${updated}` : copy.unknownUpdated}</span>
    </div>
    {(stale || error) && <div className="oa-models-notice" role="alert">
      <p>{stale ? copy.stale : copy.failed}</p>
      {error && <details><summary>{copy.errorDetails}</summary><p>{error}</p></details>}
    </div>}
    <label htmlFor={`${id}-search`}>{copy.search}</label>
    <div className="oa-models-search">
      <input ref={search} id={`${id}-search`} type="search" value={query} placeholder={copy.searchPlaceholder}
        autoComplete="off" aria-controls={`${id}-results`} aria-describedby={`${id}-count`}
        onChange={event => { setQuery(event.target.value) }} />
      {query && <button type="button" aria-label={copy.clearSearch} onClick={() => { setQuery(''); search.current?.focus() }}>
        {copy.clear}
      </button>}
    </div>
    <p id={`${id}-count`} className="oa-models-muted" role="status" aria-live="polite">
      {copy.matching}: {matches.length} / {models.length}
    </p>
    <div id={`${id}-results`} className="oa-models-results" role="region" aria-label={copy.listLabel} tabIndex={0}>
      {matches.length > 0 ? <ul>{matches.map(model => <li key={model.id} className="oa-models-item">
        <div className="oa-models-name">
          <strong>{model.displayName}</strong>
          {model.isDefault && <span className="oa-models-badge">{copy.defaultModel}</span>}
        </div>
        <code>{model.id}</code>
        {model.description && <p className="oa-models-muted">{model.description}</p>}
        {model.upgrade && <p className="oa-models-upgrade">{copy.upgrade}: <code>{model.upgrade}</code></p>}
        {(model.unsupportedReasoningEfforts?.length || model.unsupportedDefaultReasoningEffort) ? <div className="oa-models-notice">
          {Boolean(model.unsupportedReasoningEfforts?.length) && <p>
            {compatibility.excluded}: {model.unsupportedReasoningEfforts?.join(' · ')}
          </p>}
          {model.unsupportedDefaultReasoningEffort && <p>{compatibility.unsupportedDefault(model.unsupportedDefaultReasoningEffort)}</p>}
          {(model.unsupportedReasoningEfforts?.includes('ultra') || model.unsupportedDefaultReasoningEffort === 'ultra')
            && <p>{compatibility.existingUltra}</p>}
        </div> : null}
        {(model.inputModalities.length > 0 || model.supportedReasoningEfforts.length > 0) && <details>
          <summary>{copy.details}</summary>
          {model.inputModalities.length > 0 && <p>{copy.input}: {model.inputModalities.map(item => copy[item]).join(' · ')}</p>}
          {model.supportedReasoningEfforts.length > 0 && <p>{copy.reasoning}: {model.supportedReasoningEfforts.map(item =>
            `${item.reasoningEffort}${item.reasoningEffort === model.defaultReasoningEffort ? ` (${copy.defaultEffort})` : ''}`).join(' · ')}</p>}
        </details>}
      </li>)}</ul> : <p className="oa-models-item oa-models-muted">{terms.length > 0 ? copy.noMatches : copy.empty}</p>}
    </div>
    <p className="oa-models-muted">{copy.sourceHint}</p>
    <p className="oa-models-muted">{copy.accessHint}</p>
  </section>
}
