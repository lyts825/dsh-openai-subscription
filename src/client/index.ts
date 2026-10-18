import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RPC_CHANNEL, RPC_PREFIX, type SubscriptionView } from '../shared.ts'
import { SubscriptionSection, type SubscriptionInjected } from './SubscriptionSection.tsx'
import { en, zh } from './locales.ts'
import type { DelegationView } from '../delegation-shared.ts'
import { DelegationSection, type DelegationInjected } from './DelegationSection.tsx'
import { en as delegationEn, zh as delegationZh } from './delegation-locales.ts'
import type { ModelCatalogView } from '../model-catalog-types.ts'

export const inject = ['connection', 'slots', 'locale', 'remote']

/** DSH's public forwarded invalidation events; no Host modules enter the browser bundle. */
interface ModelInvalidations {
  $on(name: 'settings/document-updated' | 'credentials/record-updated' | 'credentials/reference-updated' | 'llm/adapters-updated', listener: () => void): () => void
}

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
    loadModels: signal => modelCatalogRequest('modelCatalogState', signal),
    refreshModels: signal => modelCatalogRequest('refreshModels', signal),
    request: async (action, payload, signal) => {
      const result = await connection.rpc.call(RPC_CHANNEL, RPC_PREFIX + action, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value as SubscriptionView
    },
  }
  async function modelCatalogRequest(action: 'modelCatalogState' | 'refreshModels', signal: AbortSignal): Promise<ModelCatalogView> {
    const result = await connection.rpc.call(RPC_CHANNEL, RPC_PREFIX + action, {}, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as ModelCatalogView
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-subscription',
    order: 20,
    label: () => t('nav'),
    locale: 'openai-subscription',
    inject: () => injected,
  }, SubscriptionSection))

  const delegationT = ctx.locale.bind('openai-subscription-delegation')
  ctx.effect(() => ctx.locale.register('openai-subscription-delegation', { en: delegationEn, zh: delegationZh }), 'openai-subscription: delegation dictionaries')
  const delegationRequest = async (action: 'delegationState' | 'refreshDelegation' | 'saveDelegation', payload: Record<string, unknown>, signal: AbortSignal): Promise<DelegationView> => {
    const result = await connection.rpc.call(RPC_CHANNEL, RPC_PREFIX + action, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as DelegationView
  }
  const delegation: DelegationInjected = {
    load: signal => delegationRequest('delegationState', {}, signal),
    refresh: (signal = new AbortController().signal) => delegationRequest('refreshDelegation', {}, signal),
    subscribeCatalog: listener => {
      const remote = ctx.get('remote') as ModelInvalidations
      const disposers = [
        remote.$on('settings/document-updated', listener),
        remote.$on('credentials/record-updated', listener),
        remote.$on('credentials/reference-updated', listener),
        remote.$on('llm/adapters-updated', listener),
        ctx.on('connection/reset', listener),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
    save: (revision, policy, signal) => delegationRequest('saveDelegation', { revision, policy }, signal),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-subscription-delegation',
    order: 21,
    label: () => delegationT('nav'),
    locale: 'openai-subscription-delegation',
    inject: () => delegation,
  }, DelegationSection))
}
