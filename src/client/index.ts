import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RPC_CHANNEL, RPC_PREFIX, type SubscriptionView } from '../shared.ts'
import { SubscriptionSection, type SubscriptionInjected } from './SubscriptionSection.tsx'
import { en, zh } from './locales.ts'

export const inject = ['connection', 'slots', 'locale']

/** Register a native DSH settings page; credentials remain on the Host. */
export function apply(ctx: Context): void {
  // The browser Connection exports its handle without augmenting Context.
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind('openai-subscription')
  ctx.effect(() => ctx.locale.register('openai-subscription', { en, zh }), 'openai-subscription: dictionaries')

  const injected: SubscriptionInjected = {
    // Retain an unresolved operation across settings section unmounts.
    pendingReset: { current: null },
    getLocale: () => ctx.locale.getSnapshot().active,
    request: async (action, payload, signal) => {
      const result = await connection.rpc.call(RPC_CHANNEL, RPC_PREFIX + action, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value as SubscriptionView
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-subscription',
    order: 20,
    label: () => t('nav'),
    locale: 'openai-subscription',
    inject: () => injected,
  }, SubscriptionSection))
}
