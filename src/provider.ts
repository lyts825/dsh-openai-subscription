import type { Context } from '@deepseek-ai/cordis'
import type { CredentialStore, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-attachment'
import type { Options } from './config.ts'
import { PROVIDER_ID } from './shared.ts'

/** The account service is the sole source of credentials and quota refreshes. */
export interface ProviderAccount {
  accessToken(): Promise<string>
  notifyAfterRequest(): void
}

const noAmbientCredentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  delete: async () => { throw new Error('The subscription adapter does not own OAuth storage.') },
  modify: async () => { throw new Error('The subscription adapter does not own OAuth storage.') },
}

/** Reuse DSH's message conversion, images, replay and tools with a managed Codex account. */
export function createSubscriptionAdapter(ctx: Context, account: ProviderAccount, config: Options): LlmAdapter {
  const native = openaiCodexProvider()
  const models = native.getModels().map(model => ({ ...model, provider: PROVIDER_ID }))
  const provider: Provider<'openai-codex-responses'> = {
    id: PROVIDER_ID,
    name: 'OpenAI（ChatGPT 订阅）',
    baseUrl: native.baseUrl,
    getModels: () => models,
    // A token is mandatory. There is no API-key or other-account fallback.
    auth: { apiKey: {
      name: 'Managed Codex login',
      resolve: async ({ credential }) => {
        if (!credential?.key) throw new LlmError('Sign in to ChatGPT in OpenAI Subscription settings.', 'MISSING_CREDENTIAL')
        return { auth: { apiKey: credential.key }, source: 'OpenAI subscription' }
      },
    } },
    stream: (model, context, options) => native.stream(model, context, options),
    streamSimple: (model, context, options) => native.streamSimple(model, context, options),
  }
  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER_ID, displayName: provider.name, piProvider: provider,
    transport: 'sse',
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes,
    requestImagePixelBudget: config.requestImagePixelBudget,
    requestImageMaxBytes: config.requestImageMaxBytes,
    retryPolicy: { mode: 'normal', maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0.1,
      retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT'] },
    modelErrors: new Map(), configuredMaxTokens: new Map(),
  }
  const profiles = new Map([[PROVIDER_ID, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => account.accessToken(),
    auth: { credentials: noAmbientCredentials, authContext: { env: async () => undefined, fileExists: async () => false } },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
      path => ctx.get('fs')?.processPathFromHostPath(path), ref),
    onReplayDegrade: () => ctx.logger.warn('OpenAI subscription: incompatible replay state; using provider-neutral history.'),
  })
  return new SubscriptionAdapter(adapter, account)
}

/** Keep DSH's prepared-call snapshot and refresh quota after success, failure or cancellation. */
class SubscriptionAdapter extends LlmAdapter {
  constructor(private readonly adapter: PiAiAdapter, private readonly account: ProviderAccount) { super() }
  override providerInfo(provider: string) { return this.adapter.providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.adapter.providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.adapter.listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) { return this.adapter.resolveModel(provider, model, signal) }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.adapter.prepareCall(provider, model, signal)
    return { ...prepared, stream: options => this.watch(prepared.stream(options)) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.watch(this.adapter.stream(options)) }
  private async *watch(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    try { yield* stream } finally { this.account.notifyAfterRequest() }
  }
}
