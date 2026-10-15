/** OAuth links are supplied by the Host but still validated at the browser boundary. */
export function trustedAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com'
      && url.port === '' && url.username === '' && url.password === ''
      && url.pathname === '/oauth/authorize' ? url.href : null
  } catch {
    return null
  }
}

/** Render epoch milliseconds in the browser's local timezone. */
export function localDate(milliseconds: number, locale: string): string | null {
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    year: 'numeric', timeZoneName: 'short',
  }).format(date)
}

export function percentLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : locale, { maximumFractionDigits: 1 }).format(value)
}
