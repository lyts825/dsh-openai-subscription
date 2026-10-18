import type { Context } from '@deepseek-ai/cordis'
import type { CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmAdapter, LlmError, ReasoningEffortId, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-attachment'
import type { Options } from './config.ts'
import { PROVIDER_ID } from './shared.ts'
import type { CatalogModel, ModelCatalogView } from './model-catalog-types.ts'
import { compatibleReasoning, isSupportedReasoningEffort } from './reasoning-effort.ts'

/** The account service is the sole source of credentials and quota refreshes. */
export interface ProviderAccount {
  accessToken(): Promise<string>
  notifyAfterRequest(): void
  ensureModels(): Promise<void>
  modelCatalogSnapshot(): ModelCatalogView
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
  // Exact installed descriptors supply known transport capabilities only; they
  // never add entries missing from Codex's current model/list catalog.
  const knownModels = new Map(native.getModels().map(model => [model.id, model]))
  const createCallAdapter = (entry: CatalogModel, effort: string | null): PiAiAdapter => {
    const known = knownModels.get(entry.id)
    const model: Model<'openai-codex-responses'> = {
      ...known,
      id: entry.id, name: entry.displayName, provider: PROVIDER_ID, api: 'openai-codex-responses',
      baseUrl: native.baseUrl!, input: [...entry.inputModalities], reasoning: effort !== null,
      // The private medium slot preserves an already validated Responses effort
      // exactly; Codex agent modes such as ultra must never reach this map.
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: effort, high: null, xhigh: null, max: null },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Zero is the installed PiAi transport's unknown-context sentinel. Codex's
      // wire adapter sends no max_tokens field. Unknown capacity is not exposed to DSH.
      contextWindow: known?.contextWindow ?? 0, maxTokens: known?.maxTokens ?? 0,
    }
    const provider: Provider<'openai-codex-responses'> = {
      id: PROVIDER_ID,
      name: 'OpenAI（ChatGPT 订阅）',
      baseUrl: native.baseUrl,
      getModels: () => [model],
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
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => account.accessToken(),
      auth: { credentials: noAmbientCredentials, authContext: { env: async () => undefined, fileExists: async () => false } },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
        path => ctx.get('fs')?.processPathFromHostPath(path), ref),
      onReplayDegrade: () => ctx.logger.warn('OpenAI subscription: incompatible replay state; using provider-neutral history.'),
    })
  }
  return new SubscriptionAdapter(account, createCallAdapter, knownModels)
}

/** Keep DSH's prepared-call snapshot and refresh quota after success, failure or cancellation. */
class SubscriptionAdapter extends LlmAdapter {
  constructor(
    private readonly account: ProviderAccount,
    private readonly createCallAdapter: (entry: CatalogModel, effort: string | null) => PiAiAdapter,
    private readonly knownModels: Map<string, Model<'openai-codex-responses'>>,
  ) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'OpenAI（ChatGPT 订阅）' } }
  override providerRetryPolicy(_provider: string) {
    return { mode: 'normal' as const, maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0.1,
      retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT'] }
  }
  private async entries(provider: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    if (provider !== PROVIDER_ID) throw new LlmError(`Unknown provider: ${provider}`, 'NO_ADAPTER')
    signal?.throwIfAborted()
    await this.account.ensureModels()
    signal?.throwIfAborted()
    return this.account.modelCatalogSnapshot().models.map(compatibleReasoning)
  }
  private async entry(provider: string, model: string, signal?: AbortSignal): Promise<CatalogModel> {
    const entry = (await this.entries(provider, signal)).find(entry => entry.id === model)
    if (!entry) throw new LlmError(`当前 Codex 模型目录中没有 ${model}；请在 OpenAI 订阅设置中同步模型。`, 'UNKNOWN_MODEL')
    return entry
  }
  private describe(entry: CatalogModel): LlmResolvedModelInfo {
    const known = this.knownModels.get(entry.id)
    return {
      provider: PROVIDER_ID, id: entry.id, name: entry.displayName, description: entry.description,
      inputModalities: [...entry.inputModalities],
      ...(known?.contextWindow ? { context: { contextWindow: known.contextWindow } } : {}),
      ...(entry.supportedReasoningEfforts.length ? { reasoning: {
        efforts: entry.supportedReasoningEfforts.map(option => ({ id: ReasoningEffortId(option.reasoningEffort),
          name: option.reasoningEffort, description: option.description })),
        ...(entry.defaultReasoningEffort ? { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) } : {}),
      } } : {}),
    }
  }
  override async listModels(provider: string) { return (await this.entries(provider)).map(entry => this.describe(entry)) }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.describe(await this.entry(provider, model, signal))
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const entry = await this.entry(provider, model, signal)
    return { model: this.describe(entry), stream: options => this.watch(this.streamEntry(entry, options)) }
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
  private async *streamEntry(entry: CatalogModel, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.provider !== PROVIDER_ID || options.model !== entry.id) throw new LlmError('Prepared model does not match request.', 'UNKNOWN_MODEL')
    if (!entry.supportedReasoningEfforts.length && entry.unsupportedReasoningEfforts?.length) {
      throw new LlmError(`模型 ${entry.id} 没有当前调用通道支持的推理档位。请同步模型目录或选择其他模型。`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const effort = options.reasoningEffort ?? entry.defaultReasoningEffort
    const invalidDefault = options.reasoningEffort == null ? entry.unsupportedDefaultReasoningEffort : undefined
    if (invalidDefault || (effort !== null && (!isSupportedReasoningEffort(effort) || !entry.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)))) {
      const choices = entry.supportedReasoningEfforts.map(option => option.reasoningEffort).join('、')
      throw new LlmError(`当前调用通道不支持模型 ${entry.id} 的推理档位 ${invalidDefault ?? effort}。${choices ? `请在模型选择器重新选择：${choices}。` : '请同步模型目录或选择其他模型。'}`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const adapter = this.createCallAdapter(entry, effort)
    yield* adapter.stream({ ...options, reasoningEffort: effort === null ? undefined : ReasoningEffortId('medium') })
  }
  private async *watch(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    try { yield* stream } finally { this.account.notifyAfterRequest() }
  }
}
