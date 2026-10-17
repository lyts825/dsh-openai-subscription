import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DelegationPolicy, DelegationRoute, DelegationTarget, DelegationView } from '../delegation-shared.ts'
import type { DelegationLocaleKey } from './delegation-locales.ts'
import { delegationStyles } from './delegation-styles.ts'

export interface DelegationInjected {
  load: (signal: AbortSignal) => Promise<DelegationView>
  save: (revision: number, policy: DelegationPolicy, signal: AbortSignal) => Promise<DelegationView>
}

export type DelegationSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'openai-subscription-delegation'> & InjectFace<DelegationInjected>

interface Editor {
  view: DelegationView
  draft: DelegationPolicy
  revision: number
}

const routeKey = (route: DelegationRoute | null): string => route ? JSON.stringify([route.provider, route.model]) : ''
const samePolicy = (left: DelegationPolicy, right: DelegationPolicy): boolean =>
  left.enabled === right.enabled && left.mode === right.mode && left.manualTarget === right.manualTarget
  && routeKey(left.ds) === routeKey(right.ds) && routeKey(left.gpt) === routeKey(right.gpt)
const copyPolicy = (policy: DelegationPolicy): DelegationPolicy => ({
  ...policy, ds: policy.ds ? { ...policy.ds } : null, gpt: policy.gpt ? { ...policy.gpt } : null,
})

/** A staged editor. The Host owns routing, validation and policy persistence. */
export function DelegationSection({ t, load, save }: DelegationSectionProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | null>(null)
  const [failure, setFailure] = useState<{ key: DelegationLocaleKey; details: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const mounted = useRef(false)
  const active = useRef<AbortController | null>(null)
  const id = useId()

  const accept = useCallback((view: DelegationView) => {
    setEditor(current => {
      // A refresh never silently overwrites a draft. A successful save that
      // landed despite a lost response can converge through the same rule.
      if (!current || samePolicy(current.draft, current.view.policy) || samePolicy(current.draft, view.policy)) {
        return { view, draft: copyPolicy(view.policy), revision: view.revision }
      }
      return { ...current, view }
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!mounted.current || active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy('load')
    setSaved(false)
    try {
      const view = await load(controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      accept(view)
      setFailure(null)
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      setFailure({ key: 'loadFailed', details: error instanceof Error ? error.message : String(error) })
    } finally {
      if (active.current === controller) active.current = null
      if (mounted.current && !controller.signal.aborted) setBusy(null)
    }
  }, [accept, load])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      active.current?.abort()
      active.current = null
    }
  }, [refresh])

  const view = editor?.view
  const draft = editor?.draft
  const dirty = Boolean(editor && !samePolicy(editor.draft, editor.view.policy))
  const conflicted = Boolean(editor && dirty && editor.revision !== editor.view.revision)
  const stale = Boolean(view && failure)
  const routeAvailable = (target: DelegationTarget): boolean => Boolean(draft?.[target]
    && view?.candidates.some(candidate => candidate.target === target && routeKey(candidate) === routeKey(draft[target])))
  const invalid = Boolean(draft?.enabled && (draft.mode === 'auto'
    ? !routeAvailable('ds') || !routeAvailable('gpt')
    : !routeAvailable(draft.manualTarget)))
  const canSave = Boolean(editor && view?.writable && dirty && !busy && !stale && !conflicted
    && (!draft?.enabled || (view.available && !invalid)))
  const locked = !view?.writable || busy !== null || stale || conflicted

  const edit = (patch: Partial<DelegationPolicy>) => {
    if (locked) return
    setSaved(false)
    setEditor(current => current ? { ...current, draft: { ...current.draft, ...patch } } : current)
  }
  const discard = () => {
    if (busy) return
    setSaved(false)
    setEditor(current => current ? { ...current, draft: copyPolicy(current.view.policy), revision: current.view.revision } : current)
  }
  const commit = async () => {
    if (!canSave || !editor || active.current || !mounted.current) return
    const controller = new AbortController()
    active.current = controller
    const policy = copyPolicy(editor.draft)
    setBusy('save')
    setSaved(false)
    try {
      const result = await save(editor.revision, policy, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      accept(result)
      if (samePolicy(policy, result.policy)) {
        setFailure(null)
        setSaved(true)
      } else {
        setFailure({ key: 'saveFailed', details: result.error ?? '' })
      }
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      setFailure({ key: 'saveFailed', details: error instanceof Error ? error.message : String(error) })
    } finally {
      if (active.current === controller) active.current = null
      if (mounted.current && !controller.signal.aborted) setBusy(null)
    }
  }

  const modelField = (target: DelegationTarget) => {
    if (!view || !draft) return null
    const candidates = view.candidates.filter(candidate => candidate.target === target)
      .filter((candidate, index, all) => all.findIndex(item => routeKey(item) === routeKey(candidate)) === index)
    const selected = draft[target]
    const unavailable = selected !== null && !candidates.some(candidate => routeKey(candidate) === routeKey(selected))
    const unused = draft.mode === 'manual' && draft.manualTarget !== target
    const selectId = `${id}-${target}`
    return <div className="oa-delegate-field">
      <label htmlFor={selectId}>{t(target === 'ds' ? 'deepseekModel' : 'gptModel')}</label>
      <select id={selectId} value={routeKey(selected)}
        disabled={locked || !draft.enabled || !view.available || unused}
        aria-describedby={`${selectId}-help`} aria-invalid={draft.enabled && !unused && !routeAvailable(target)}
        onChange={event => {
          const candidate = candidates.find(candidate => routeKey(candidate) === event.target.value)
          edit({ [target]: candidate ? { provider: candidate.provider, model: candidate.model } : null })
        }}>
        <option value="">{t('chooseModel')}</option>
        {unavailable && <option value={routeKey(selected)} disabled>
          {t('unavailable')} · {selected.provider}/{selected.model}
        </option>}
        {candidates.map(candidate => <option key={routeKey(candidate)} value={routeKey(candidate)}>
          {candidate.modelName} · {candidate.providerName} ({candidate.provider}/{candidate.model})
        </option>)}
      </select>
      <div id={`${selectId}-help`} className="oa-delegate-muted oa-delegate-route">
        {selected && <p>{selected.provider}/{selected.model}</p>}
        {unused ? <p>{t('optionalModel')}</p> : candidates.length === 0 ? <p>{t('noModels')}</p> : null}
      </div>
    </div>
  }

  return <div className="dsh-openai-delegation">
    <style>{delegationStyles}</style>
    <div className="oa-delegate-heading">
      <h2>{t('title')}</h2>
      <p className="oa-delegate-muted">{t('intro')}</p>
    </div>
    <div className="oa-delegate-actions">
      <button type="button" disabled={busy !== null} onClick={() => { void refresh() }}>
        {t(busy === 'load' ? 'refreshing' : 'refresh')}
      </button>
    </div>
    {!editor && busy === 'load' && <p role="status">{t('loading')}</p>}
    {failure && <div className="oa-delegate-notice" role="alert">
      <p>{t(failure.key)}</p>
      {stale && <p>{t('stale')}</p>}
      {failure.details && <details><summary>{t('errorDetails')}</summary><pre>{failure.details}</pre></details>}
    </div>}
    {view && draft && <>
      {!view.available && <p className="oa-delegate-notice" role="status">{t('unavailableHost')}</p>}
      {!view.writable && <p className="oa-delegate-notice" role="status">{t('readOnly')}</p>}
      {view.error && <div className="oa-delegate-notice" role="alert">
        <details open><summary>{t('errorDetails')}</summary><pre>{view.error}</pre></details>
      </div>}
      {view.catalogFailures.length > 0 && <div className="oa-delegate-notice" role="status">
        <p>{t('partialCatalog')}</p>
        <details><summary>{t('errorDetails')}</summary>
          {view.catalogFailures.map((item, index) => <p key={`${item.provider}-${index}`}>{item.provider}: {item.message}</p>)}
        </details>
      </div>}
      <section className="oa-delegate-card" aria-label={t('title')} aria-busy={busy !== null}>
        <label className="oa-delegate-choice">
          <input type="checkbox" checked={draft.enabled} disabled={locked || (!view.available && !draft.enabled)}
            onChange={event => { edit({ enabled: event.target.checked }) }} />
          {t('enabled')}
        </label>
        {!draft.enabled && <p className="oa-delegate-muted">{t('disabledHint')}</p>}
        <fieldset disabled={locked || !draft.enabled || !view.available}>
          <legend>{t('mode')}</legend>
          <div className="oa-delegate-choices">
            {(['auto', 'manual'] as const).map(mode => <label className="oa-delegate-choice" key={mode}>
              <input type="radio" name={`${id}-mode`} value={mode} checked={draft.mode === mode}
                onChange={() => { edit({ mode }) }} />
              {t(mode === 'auto' ? 'automatic' : 'manual')}
            </label>)}
          </div>
          <p className="oa-delegate-muted">{t(draft.mode === 'auto' ? 'automaticHint' : 'manualHint')}</p>
        </fieldset>
        {draft.mode === 'manual' && <fieldset disabled={locked || !draft.enabled || !view.available}>
          <legend>{t('target')}</legend>
          <div className="oa-delegate-choices">
            {(['ds', 'gpt'] as const).map(target => <label className="oa-delegate-choice" key={target}>
              <input type="radio" name={`${id}-target`} value={target} checked={draft.manualTarget === target}
                onChange={() => { edit({ manualTarget: target }) }} />
              {t(target === 'ds' ? 'deepseek' : 'gpt')}
            </label>)}
          </div>
        </fieldset>}
        <div className="oa-delegate-grid">{modelField('ds')}{modelField('gpt')}</div>
        <p className="oa-delegate-muted">{t('catalogHint')}</p>
        {invalid && <p className="oa-delegate-invalid" role="status">{t(draft.mode === 'auto' ? 'autoRequired' : 'manualRequired')}</p>}
        {conflicted && <p className="oa-delegate-notice" role="alert">{t('conflict')}</p>}
        <div className="oa-delegate-actions">
          <button type="button" className="oa-delegate-primary" disabled={!canSave} onClick={() => { void commit() }}>
            {t(busy === 'save' ? 'saving' : 'save')}
          </button>
          <button type="button" disabled={!dirty || busy !== null} onClick={discard}>{t('discard')}</button>
        </div>
      </section>
      <p className="oa-delegate-muted">{t('newSessions')}</p>
      {draft.enabled && <p className="oa-delegate-muted">{t('nativeTools')}</p>}
      {saved && <p className="oa-delegate-notice oa-delegate-success" role="status">{t('saved')}</p>}
    </>}
  </div>
}
