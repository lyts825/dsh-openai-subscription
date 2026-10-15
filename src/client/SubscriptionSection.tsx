import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResetCredit, ResetOperation, SubscriptionView } from '../shared.ts'
import type { SubscriptionLocaleKey } from './locales.ts'
import { localDate, percentLabel, trustedAuthorizationUrl } from './format.ts'
import { styles } from './styles.ts'

export type SubscriptionAction = 'state' | 'refresh' | 'login' | 'cancelLogin' | 'logout' | 'prepareReset' | 'consumeReset'

export interface SubscriptionInjected {
  request: (action: SubscriptionAction, payload: Record<string, unknown>, signal: AbortSignal) => Promise<SubscriptionView>
  getLocale: () => string
  /** Transport failures must not unlock a new-card operation on a remount. */
  pendingReset: { current: string | null }
}

export type SubscriptionSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'openai-subscription'> & InjectFace<SubscriptionInjected>

const outcomeKeys: Record<NonNullable<ResetOperation['outcome']>, SubscriptionLocaleKey> = {
  reset: 'resetDone', alreadyRedeemed: 'alreadyRedeemed', nothingToReset: 'nothingToReset', noCredit: 'noCredit',
}

export function SubscriptionSection({ t, request, getLocale, pendingReset }: SubscriptionSectionProps) {
  const [view, setView] = useState<SubscriptionView | null>(null)
  const [busy, setBusy] = useState<SubscriptionAction | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [uncertainId, setUncertainId] = useState(pendingReset.current)
  const [selectedCredit, setSelectedCredit] = useState('')
  const [confirmationId, setConfirmationId] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle')
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false)
  const inFlight = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const confirmTrigger = useRef<HTMLButtonElement>(null)
  const cancelConfirmation = useRef<HTMLButtonElement>(null)
  const manualLink = useRef<HTMLInputElement>(null)
  const copySequence = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const locale = getLocale()

  const perform = useCallback(async (
    action: SubscriptionAction,
    payload: Record<string, unknown> = {},
  ): Promise<SubscriptionView | null> => {
    if (!mounted.current || inFlight.current) return null
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(action)
    let terminalReset = false
    if (action === 'consumeReset') {
      pendingReset.current = String(payload.operationId)
    }
    const current = () => mounted.current && !controller.signal.aborted
    const accept = (next: SubscriptionView) => {
      if (!current()) return
      setFailure(null)
      if (next.operation?.status === 'completed' && next.operation.id === pendingReset.current) {
        pendingReset.current = null
        terminalReset = true
      } else if (action === 'refresh' && next.operation?.id === pendingReset.current
        && next.operation.status === 'prepared' && next.operation.expiresAt !== null
        && next.operation.expiresAt <= Date.now()) {
        // A Host refresh runs after pending mutations. An expired preparation
        // still in this state proves redemption was never sent; a lightweight
        // state snapshot alone cannot establish that ordering.
        pendingReset.current = null
      } else if (next.operation?.status === 'uncertain') {
        pendingReset.current = next.operation.id
      }
      setUncertainId(pendingReset.current)
      setView(next)
    }
    try {
      const next = await request(action, payload, controller.signal)
      if (!current()) return null
      accept(next)
      // A successful terminal result is retained even if the follow-up read fails.
      if (action === 'consumeReset' && next.operation?.status === 'completed') {
        terminalReset = true
        const refreshed = await request('refresh', {}, controller.signal)
        if (!current()) return null
        accept(refreshed)
        return refreshed
      }
      return next
    } catch (error) {
      if (!current()) return null
      setFailure(error instanceof Error ? error.message : String(error))
      if (action === 'consumeReset' && !terminalReset) setUncertainId(pendingReset.current)
      return null
    } finally {
      if (inFlight.current === controller) inFlight.current = null
      if (current()) setBusy(null)
    }
  }, [pendingReset, request])

  useEffect(() => {
    mounted.current = true
    const visible = () => document.visibilityState === 'visible'
      && root.current !== null && root.current.getClientRects().length > 0
    const sync = () => { if (visible()) void perform('state') }
    void perform('refresh')
    const timer = window.setInterval(sync, 30_000)
    document.addEventListener('visibilitychange', sync)
    return () => {
      mounted.current = false
      inFlight.current?.abort()
      inFlight.current = null
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [perform])

  const operation = view?.operation
  const confirmation = operation?.id === confirmationId && operation.status === 'prepared' ? operation : null
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (confirmation) {
      setNow(Date.now())
      if (!element.open) {
        element.showModal()
        cancelConfirmation.current?.focus({ preventScroll: true })
      }
      const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
      return () => { window.clearInterval(timer) }
    }
    if (element.open) {
      element.close()
      const trigger = confirmTrigger.current
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true })
    }
  }, [confirmation])

  useEffect(() => {
    copySequence.current++
    setCopyStatus('idle')
  }, [view?.login?.id, view?.login?.url])

  useEffect(() => {
    if (copyStatus !== 'manual') return
    manualLink.current?.focus({ preventScroll: true })
    manualLink.current?.select()
  }, [copyStatus])

  const credits = view?.usage?.resetCredits
  useEffect(() => {
    if (selectedCredit && !credits?.credits?.some(credit => credit.id === selectedCredit)) setSelectedCredit('')
  }, [credits, selectedCredit])

  const formatSeconds = (seconds: number | null) => seconds === null ? null : localDate(seconds * 1000, locale)
  const creditName = (credit: ResetCredit, index: number) => credit.title ?? t('creditNumber', { number: index + 1 })
  const creditExpiry = (credit: ResetCredit) => {
    const date = formatSeconds(credit.expiresAt)
    return date ? t('expires', { time: date }) : t('expiryUnknown')
  }
  const cardDescription = (creditId: string | null) => {
    if (creditId === null) return t('autoCredit')
    const index = credits?.credits?.findIndex(credit => credit.id === creditId) ?? -1
    const credit = index < 0 ? null : credits?.credits?.[index]
    return credit ? `${creditName(credit, index)} · ${creditExpiry(credit)}` : creditId
  }
  const prepare = async () => {
    if (pendingReset.current) return
    const next = await perform('prepareReset', { creditId: selectedCredit || null })
    if (mounted.current && next?.operation?.status === 'prepared') setConfirmationId(next.operation.id)
  }
  const consume = () => {
    if (!confirmation || confirmation.expiresAt === null || confirmation.expiresAt <= Date.now()) return
    setConfirmationId(null)
    void perform('consumeReset', { operationId: confirmation.id })
  }
  const stale = Boolean(view?.usage && (view.stale || failure))
  const error = failure ?? view?.error
  const waiting = uncertainId ?? (operation?.status === 'uncertain' ? operation.id : null)
  const loginUrl = view?.login ? trustedAuthorizationUrl(view.login.url) : null
  const copyLoginLink = async () => {
    if (!loginUrl || copyStatus === 'copying') return
    const sequence = ++copySequence.current
    setCopyStatus('copying')
    try {
      // Desktop shells and regular browsers both own Clipboard permission.
      // Only this explicit user action writes; denial exposes a selectable URL.
      await navigator.clipboard.writeText(loginUrl)
      if (mounted.current && sequence === copySequence.current) setCopyStatus('copied')
    } catch {
      if (mounted.current && sequence === copySequence.current) setCopyStatus('manual')
    }
  }
  const hasWindows = Boolean(view?.usage?.buckets.some(bucket => bucket.windows.length > 0))
  const expiredConfirmation = Boolean(confirmation && (confirmation.expiresAt === null || confirmation.expiresAt <= now))
  const confirmedDate = confirmation?.expiresAt ? localDate(confirmation.expiresAt, locale) : null
  const updated = view?.usage ? localDate(view.usage.updatedAt, locale) : null

  return (
    <div className="dsh-openai-subscription" ref={root}>
      <style>{styles}</style>
      <header className="oa-heading">
        <h2>{t('title')}</h2>
        <p className="oa-subtle">{t('intro')}</p>
      </header>

      <section className="oa-card" aria-label={t('title')} aria-busy={busy === 'login' || busy === 'logout'}>
        {view === null ? <p role="status">{t(failure && busy === null ? 'error' : 'loading')}</p> : (
          <div className="oa-row">
            <div className="oa-account">
              {view.account ? <>
                <strong>{view.account.email ?? t('unknownEmail')}</strong>
                <span className="oa-subtle">{t('plan')} · {view.account.planType ?? t('unknownPlan')}</span>
              </> : <p className="oa-subtle">{t('loggedOut')}</p>}
            </div>
            <div className="oa-actions">
              {view.account ? <>
                <button type="button" disabled={busy !== null} onClick={() => { void perform('refresh') }}>
                  {busy === 'refresh' ? t('refreshing') : t('refresh')}
                </button>
                <button type="button" disabled={busy !== null || waiting !== null} onClick={() => { void perform('logout') }}>
                  {t('logout')}
                </button>
              </> : !view.login && (
                <button className="oa-primary" type="button" disabled={busy !== null} onClick={() => { void perform('login') }}>
                  {busy === 'login' ? t('working') : t('login')}
                </button>
              )}
            </div>
          </div>
        )}
        {view?.login && <div className="oa-notice" role="status">
          <p>{loginUrl ? t('loginPending') : t('unsafeLoginUrl')}</p>
          <div className="oa-actions">
            {loginUrl && <a className="oa-link" href={loginUrl} target="_blank" rel="noopener noreferrer">{t('authorize')}</a>}
            {loginUrl && <button type="button" disabled={copyStatus === 'copying'} onClick={() => { void copyLoginLink() }}>
              {t(copyStatus === 'copying' ? 'copyingLink' : 'copyLoginLink')}
            </button>}
            <button type="button" disabled={busy !== null} onClick={() => { void perform('cancelLogin') }}>{t('cancelLogin')}</button>
          </div>
          {copyStatus === 'copied' && <p role="status">{t('linkCopied')}</p>}
          {copyStatus === 'manual' && loginUrl && <label className="oa-field">
            <span role="status">{t('copyLinkManually')}</span>
            <input ref={manualLink} className="oa-copy-link" type="text" readOnly value={loginUrl}
              aria-label={t('loginLink')} onFocus={event => { event.currentTarget.select() }} />
          </label>}
        </div>}
      </section>

      {(stale || error) && <div className="oa-notice" role="alert">
        <p>{stale ? t('stale') : t('error')}</p>
        {error && <details>
          <summary>{t('errorDetails')}</summary>
          <p className="oa-error-detail">{error}</p>
        </details>}
        {!view?.account && <div className="oa-actions">
          <button type="button" disabled={busy !== null} onClick={() => { void perform('refresh') }}>{t('refresh')}</button>
        </div>}
      </div>}

      {view?.account && <>
        <section className="oa-card" aria-labelledby={`${id}-quotas`} aria-busy={busy === 'refresh'}>
          <h3 id={`${id}-quotas`}>{t('quotas')}</h3>
          {!view.usage ? <p className="oa-subtle">{t('noUsage')}</p> : !hasWindows ? (
            <p className="oa-subtle">{t('noWindows')}</p>
          ) : view.usage.buckets.filter(bucket => bucket.windows.length > 0).map(bucket => (
            <div className="oa-bucket" key={bucket.id}>
              <h3>{bucket.name}</h3>
              <div className="oa-grid">
                {bucket.windows.map(window => {
                  const label = window.durationMins === 300 ? t('fiveHour') : t('weekly')
                  const reset = formatSeconds(window.resetsAt)
                  return <div className="oa-window" key={window.durationMins}>
                    <strong>{label}</strong>
                    <div className="oa-row">
                      <span className="oa-percent">{t('remaining', { percent: percentLabel(window.remainingPercent, locale) })}</span>
                      <span className="oa-subtle">{t('used', { percent: percentLabel(window.usedPercent, locale) })}</span>
                    </div>
                    <progress max={100} value={window.usedPercent} aria-label={`${bucket.name} · ${label}`} />
                    <p className="oa-subtle">{reset ? t('resets', { time: reset }) : t('unknownReset')}</p>
                  </div>
                })}
              </div>
            </div>
          ))}
          <div className="oa-meta oa-subtle">
            {updated && <span>{t('updated', { time: updated })}</span>}
            <span>{t('localTime')}</span>
          </div>
        </section>

        <section className="oa-card" aria-labelledby={`${id}-credits`} aria-busy={busy === 'prepareReset' || busy === 'consumeReset'}>
          <div className="oa-row">
            <h3 id={`${id}-credits`}>{t('creditsTitle')}</h3>
            {credits && <span>{t('creditsCount', { count: credits.availableCount })}</span>}
          </div>
          {!credits ? <p className="oa-subtle">{t('creditsUnknown')}</p> : credits.availableCount === 0 ? (
            <p className="oa-subtle">{t('creditsEmpty')}</p>
          ) : <>
            {credits.credits && credits.credits.length > 0 ? <>
              <label className="oa-field" htmlFor={`${id}-card`}>
                <span>{t('creditLabel')}</span>
                <select id={`${id}-card`} value={selectedCredit} disabled={busy !== null || waiting !== null}
                  onChange={event => { setSelectedCredit(event.target.value) }}>
                  <option value="">{t('autoCredit')}</option>
                  {credits.credits.map((credit, index) => <option key={credit.id} value={credit.id}
                    disabled={credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now()}>
                    {creditName(credit, index)} · {creditExpiry(credit)}
                  </option>)}
                </select>
              </label>
              <ul className="oa-credit-list">
                {credits.credits.map((credit, index) => <li key={credit.id}>
                  {creditName(credit, index)}<span className="oa-subtle">{creditExpiry(credit)}</span>
                </li>)}
              </ul>
            </> : <p className="oa-subtle">{t('autoCredit')} · {t('expiryUnknown')}</p>}
            <div className="oa-actions">
              <button ref={confirmTrigger} type="button" disabled={busy !== null || waiting !== null || stale || Boolean(view.error)} onClick={() => { void prepare() }}>
                {busy === 'prepareReset' ? t('prepare') : busy === 'consumeReset' ? t('consuming') : t('useCredit')}
              </button>
            </div>
            {(stale || view.error) && <p className="oa-subtle">{t('refreshBeforeReset')}</p>}
          </>}
          {operation?.status === 'completed' && <p className={`oa-notice${operation.outcome === 'reset' ? ' oa-success' : ''}`} role="status">
            {t(operation.outcome === null ? 'resultUnknown' : outcomeKeys[operation.outcome])}
          </p>}
        </section>
      </>}

      {waiting && <div className="oa-notice" role="alert">
        <p>{t('uncertain')}</p>
        <p className="oa-subtle">{t('retryHelp')}</p>
        <div className="oa-actions">
          <button type="button" disabled={busy !== null} onClick={() => { void perform('consumeReset', { operationId: waiting }) }}>
            {busy === 'consumeReset' ? t('consuming') : t('retryReset')}
          </button>
        </div>
      </div>}

      <dialog ref={dialog} role={confirmation ? 'dialog' : undefined} aria-modal={confirmation ? true : undefined}
        data-shortcut-modal={confirmation ? 'openai-subscription-reset' : undefined}
        aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-body`}
        onKeyDown={event => {
          if (!confirmation || (event.key !== 'Escape' && event.key !== 'Tab')) return
          // DSH settings also owns a document-level modal keyboard handler.
          // Let the native dialog contain Tab, and keep Escape within this layer.
          event.stopPropagation()
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
            || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
          event.preventDefault()
          if (!event.repeat) setConfirmationId(null)
        }}
        onCancel={event => { event.preventDefault(); setConfirmationId(null) }}>
        {confirmation && <div className="oa-confirm">
          <h3 id={`${id}-confirm-title`}>{t('confirmTitle')}</h3>
          <p id={`${id}-confirm-body`}>{t('confirmBody')}</p>
          <p>{t('confirmCard', { card: cardDescription(confirmation.creditId) })}</p>
          <p className="oa-subtle">{expiredConfirmation ? t('confirmExpired') : confirmedDate ? t('confirmExpires', { time: confirmedDate }) : t('prepared')}</p>
          <div className="oa-actions">
            <button ref={cancelConfirmation} type="button" onClick={() => { setConfirmationId(null) }}>{t('cancel')}</button>
            <button className="oa-primary" type="button" disabled={busy !== null || expiredConfirmation} onClick={consume}>{t('confirmUse')}</button>
          </div>
        </div>}
      </dialog>
    </div>
  )
}
