import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultDelegationPolicy, type DelegationCandidate, type DelegationPolicy, type DelegationRoute, type DelegationTarget, type DelegationView } from './delegation-shared.ts'

const MAX_CONFIG_BYTES = 64 * 1024
const STORAGE_ERROR = '委派设置无法读取或格式不兼容，已停用委派；请修复配置文件后重试。'
const CATALOG_ERROR = '无法读取模型目录，请稍后重试。'
const POLICY_KEYS = ['enabled', 'mode', 'manualTarget', 'ds', 'gpt']
const NATIVE_SERVICES = ['llm', 'tools', 'subagents', 'agents', 'sessionProjections', 'systemPrompt', 'storage', 'storageDomain', 'sessionPersistence', 'sessionQuery']

/** Only fixed, credential-free messages from this class may cross the settings RPC boundary. */
export class DelegationSettingsError extends Error {
  constructor(message: string, readonly code: 'conflict' | 'invalid' | 'unavailable' | 'storage') {
    super(message)
    this.name = 'DelegationSettingsError'
  }
}

interface StoredPolicy { version: 1; revision: number; policy: DelegationPolicy }
interface Catalog { candidates: DelegationCandidate[]; catalogFailures: DelegationView['catalogFailures']; error: string | null }

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
}

function routeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
}

function effortText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\s\p{Cc}]/u.test(value)
}

function parseRoute(value: unknown): DelegationRoute | null {
  if (value === null) return null
  const route = object(value)
  if (!route || (!exactKeys(route, ['provider', 'model']) && !exactKeys(route, ['provider', 'model', 'reasoningEffort']))
    || !routeText(route.provider) || !routeText(route.model)) {
    throw new DelegationSettingsError('委派模型必须是有效的 provider/model 路由。', 'invalid')
  }
  if (Object.hasOwn(route, 'reasoningEffort') && !effortText(route.reasoningEffort)) {
    throw new DelegationSettingsError('委派推理档位必须是有效的非空标识，不能包含空白或控制字符，且不超过 64 个字符。', 'invalid')
  }
  return { provider: route.provider, model: route.model,
    ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}) }
}

/** Copy bounded exact-model metadata, without inferring provider-wide capabilities. */
function reasoningView(value: unknown): DelegationCandidate['reasoning'] {
  const reasoning = object(value)
  if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length > 64) return undefined
  const efforts: NonNullable<DelegationCandidate['reasoning']>['efforts'] = []
  const seen = new Set<string>()
  for (const value of reasoning.efforts) {
    const option = object(value)
    if (!option || !effortText(option.id) || seen.has(option.id) || typeof option.name !== 'string'
      || !option.name.trim() || option.name.length > 512 || /[\p{Cc}]/u.test(option.name)) continue
    const description = typeof option.description === 'string' && option.description.length <= 2000
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(option.description) ? option.description : undefined
    efforts.push({ id: option.id, name: option.name, ...(description === undefined ? {} : { description }) })
    seen.add(option.id)
  }
  return { efforts,
    ...(effortText(reasoning.defaultEffort) && seen.has(reasoning.defaultEffort) ? { defaultEffort: reasoning.defaultEffort } : {}) }
}

/** Validate persisted preferences and immutable Session policy snapshots without accepting credentials. */
export function parseDelegationPolicy(value: unknown): DelegationPolicy {
  const policy = object(value)
  if (!policy || !exactKeys(policy, POLICY_KEYS) || typeof policy.enabled !== 'boolean'
    || (policy.mode !== 'auto' && policy.mode !== 'manual') || (policy.manualTarget !== 'ds' && policy.manualTarget !== 'gpt')) {
    throw new DelegationSettingsError('委派设置格式无效。', 'invalid')
  }
  const parsed: DelegationPolicy = { enabled: policy.enabled, mode: policy.mode, manualTarget: policy.manualTarget,
    ds: parseRoute(policy.ds), gpt: parseRoute(policy.gpt) }
  if (parsed.enabled) {
    const required: DelegationTarget[] = parsed.mode === 'auto' ? ['ds', 'gpt'] : [parsed.manualTarget]
    for (const target of required) {
      const route = parsed[target]
      if (!route || familyOf(route.provider, route.model) !== target) throw new DelegationSettingsError('已启用的委派设置缺少匹配的模型路由。', 'invalid')
    }
  }
  return parsed
}

function revisionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function familyOf(provider: string, model: string): DelegationTarget | undefined {
  if (/^(?:gpt-|chatgpt-)/iu.test(model)) return 'gpt'
  if (['deepseek-account', 'deepseek-official', 'deepseek'].includes(provider.toLowerCase())
    || /^deepseek(?:[-_/]|$)/iu.test(model)) return 'ds'
}

function nativeAvailable(ctx: Context): boolean {
  try {
    if (NATIVE_SERVICES.some(name => ctx.get(name) == null)) return false
    return ctx.get('subagents').getProvider('spawn') != null
  } catch { return false }
}

/** Profile-owned routing preferences. Account credentials and their lifecycle lock are never inspected. */
export class DelegationSettings {
  private readonly filename: string
  private readonly lockPath: string
  private value: StoredPolicy = { version: 1, revision: 0, policy: defaultDelegationPolicy() }
  private storageError: string | null = null
  private initialized = false
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()
  private lastCatalog: Catalog = { candidates: [], catalogFailures: [], error: null }

  constructor(private readonly ctx: Context, home: string) {
    if (!isAbsolute(home)) throw new DelegationSettingsError('委派设置目录必须是绝对路径。', 'invalid')
    this.filename = join(resolve(home), 'dsh-delegation-settings.json')
    this.lockPath = `${this.filename}.lock`
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.disposed) throw new DelegationSettingsError('委派设置服务已停止。', 'unavailable')
      return action()
    })
    this.queue = next.catch(() => {})
    return next
  }

  async initialize(): Promise<void> { await this.run(() => this.reload()) }

  current(): DelegationPolicy {
    return structuredClone(this.initialized && !this.storageError ? this.value.policy : defaultDelegationPolicy())
  }

  private async readStored(): Promise<StoredPolicy> {
    let info
    try { info = await lstat(this.filename) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, policy: defaultDelegationPolicy() }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error(STORAGE_ERROR)
    const bytes = await readFile(this.filename)
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error(STORAGE_ERROR)
    const stored = object(JSON.parse(bytes.toString('utf8')))
    if (!stored || !exactKeys(stored, ['version', 'revision', 'policy']) || stored.version !== 1 || !revisionNumber(stored.revision)) {
      throw new Error(STORAGE_ERROR)
    }
    return { version: 1, revision: stored.revision, policy: parseDelegationPolicy(stored.policy) }
  }

  private async reload(): Promise<void> {
    try { this.value = await this.readStored(); this.storageError = null }
    catch { this.storageError = STORAGE_ERROR }
    this.initialized = true
  }

  private async catalog(signal?: AbortSignal): Promise<Catalog> {
    signal?.throwIfAborted()
    const llm = this.ctx.get('llm')
    if (!llm) return { candidates: [], catalogFailures: [], error: CATALOG_ERROR }
    let providers: { id: string; name: string }[]
    try { providers = llm.listProviders() }
    catch { return { candidates: [], catalogFailures: [], error: CATALOG_ERROR } }
    const results = await Promise.allSettled(providers.map(async provider => {
      const models = await llm.listModels(provider.id)
      const candidates: DelegationCandidate[] = models.flatMap(model => {
        const target = familyOf(provider.id, model.id)
        return target && routeText(provider.id) && routeText(model.id)
          ? [{ provider: provider.id, providerName: provider.name, model: model.id, modelName: model.name, target }]
          : []
      })
      // listModels deliberately projects only basic labels. Resolve through the
      // LLM service so exact-route metadata receives the same validation as DSH's picker.
      const metadata = await Promise.allSettled(candidates.map(async candidate => {
        signal?.throwIfAborted()
        return reasoningView((await llm.resolveModelInfo(provider.id, candidate.model, signal)).reasoning)
      }))
      signal?.throwIfAborted()
      return { candidates: candidates.map((candidate, index) => {
        const result = metadata[index]!
        return result.status === 'fulfilled' && result.value !== undefined ? { ...candidate, reasoning: result.value } : candidate
      }), partial: metadata.some(result => result.status === 'rejected') }
    }))
    signal?.throwIfAborted()
    const candidates: DelegationCandidate[] = []
    const catalogFailures: DelegationView['catalogFailures'] = []
    const seen = new Set<string>()
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        catalogFailures.push({ provider: providers[index].id, message: '此提供方的模型目录暂时不可用。' })
        return
      }
      if (result.value.partial) catalogFailures.push({ provider: providers[index].id, message: '部分模型的推理档位暂时无法读取；其他模型仍可使用，请刷新目录后重试。' })
      for (const candidate of result.value.candidates) {
        const key = JSON.stringify([candidate.provider, candidate.model])
        if (!seen.has(key)) { seen.add(key); candidates.push(candidate) }
      }
    })
    return { candidates, catalogFailures, error: null }
  }

  private view(catalog: Catalog): DelegationView {
    return { revision: this.value.revision, policy: this.current(), candidates: structuredClone(catalog.candidates),
      catalogFailures: structuredClone(catalog.catalogFailures), available: nativeAvailable(this.ctx),
      writable: this.initialized && !this.storageError && !this.disposed, error: this.storageError ?? catalog.error }
  }

  state(signal?: AbortSignal): Promise<DelegationView> {
    return this.run(async () => {
      await this.reload()
      this.lastCatalog = await this.catalog(signal)
      return this.view(this.lastCatalog)
    })
  }

  save(revision: number, input: unknown, signal?: AbortSignal): Promise<DelegationView> {
    return this.run(async () => {
      signal?.throwIfAborted()
      if (!revisionNumber(revision)) throw new DelegationSettingsError('委派设置版本无效，请刷新后重试。', 'invalid')
      const policy = parseDelegationPolicy(input)
      // Disabling must remain possible when a provider's discovery call is unavailable.
      const catalog = policy.enabled ? await this.catalog(signal) : structuredClone(this.lastCatalog)
      if (policy.enabled) this.lastCatalog = catalog
      if (policy.enabled) {
        if (!nativeAvailable(this.ctx)) throw new DelegationSettingsError('原生子代理功能不可用，无法启用委派。', 'unavailable')
        if (catalog.error) throw new DelegationSettingsError(catalog.error, 'unavailable')
        const required: DelegationTarget[] = policy.mode === 'auto' ? ['ds', 'gpt'] : [policy.manualTarget]
        for (const target of required) {
          const route = policy[target]
          const candidate = route ? catalog.candidates.find(candidate => candidate.target === target
            && candidate.provider === route.provider && candidate.model === route.model) : undefined
          if (!route || !candidate) {
            if (route && catalog.catalogFailures.some(failure => failure.provider === route.provider)) {
              throw new DelegationSettingsError('所选提供方的模型目录暂时不可用，请稍后重试。', 'unavailable')
            }
            throw new DelegationSettingsError(`${target === 'ds' ? 'DeepSeek' : 'GPT'} 模型不在当前目录中，请重新选择。`, 'invalid')
          }
          if (route.reasoningEffort !== undefined) {
            if (!candidate.reasoning?.efforts.length) {
              throw new DelegationSettingsError('所选模型未提供可验证的推理档位，请选择“跟随 DSH 默认”或更新模型目录。', 'invalid')
            }
            if (!candidate.reasoning.efforts.some(effort => effort.id === route.reasoningEffort)) {
              throw new DelegationSettingsError('所选模型不支持该推理档位，请重新选择或改为“跟随 DSH 默认”。', 'invalid')
            }
          }
        }
      }
      await this.withLock(async () => {
        signal?.throwIfAborted()
        await this.reload()
        if (this.storageError) throw new DelegationSettingsError(this.storageError, 'storage')
        if (revision !== this.value.revision) throw new DelegationSettingsError('委派设置已被其他窗口修改，请刷新后重试。', 'conflict')
        if (revision === Number.MAX_SAFE_INTEGER) throw new DelegationSettingsError('委派设置版本已达到上限。', 'storage')
        const next: StoredPolicy = { version: 1, revision: revision + 1, policy }
        const temporary = `${this.filename}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify(next), 'utf8'); await file.sync() }
          finally { await file.close() }
          signal?.throwIfAborted()
          await rename(temporary, this.filename)
          this.value = next
          this.storageError = null
        } finally { await unlink(temporary).catch(() => {}) }
      }, signal)
      return this.view(catalog)
    }).catch(error => {
      if (error instanceof DelegationSettingsError) throw error
      if (signal?.aborted) throw new DelegationSettingsError('委派设置保存已取消。', 'unavailable')
      throw new DelegationSettingsError('委派设置保存失败，请检查目录权限并刷新后重试。', 'storage')
    })
  }

  private async withLock(action: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    await mkdir(resolve(this.filename, '..'), { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    let acquired = false
    const deadline = Date.now() + 2000
    while (!acquired && Date.now() < deadline) {
      signal?.throwIfAborted()
      try {
        const file = await open(this.lockPath, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.sync(); acquired = true }
        finally { await file.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new DelegationSettingsError('无法锁定委派设置，请检查目录权限。', 'storage')
        let owner: Record<string, unknown> | null = null
        try { owner = object(JSON.parse(await readFile(this.lockPath, 'utf8'))) } catch { /* An in-progress owner may not have flushed yet. */ }
        if (owner && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0
          && typeof owner.nonce === 'string' && /^[0-9a-f-]{36}$/iu.test(owner.nonce)) {
          let alive = true
          try { process.kill(owner.pid, 0) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
          if (!alive) {
            const reclaim = `${this.lockPath}.${owner.nonce}.reclaim`
            let held = false
            try {
              await mkdir(reclaim); held = true
              const latest = object(JSON.parse(await readFile(this.lockPath, 'utf8')))
              if (latest?.nonce === owner.nonce) await unlink(this.lockPath)
            } catch { /* Another saver may already be recovering this owner. */ }
            finally { if (held) await rmdir(reclaim).catch(() => {}) }
          }
        }
        await delay(25, undefined, { signal })
      }
    }
    if (!acquired) throw new DelegationSettingsError('另一窗口正在保存委派设置，请稍后重试。', 'unavailable')
    try { await action() }
    finally {
      const owner = await readFile(this.lockPath, 'utf8').then(text => object(JSON.parse(text))).catch(() => null)
      if (owner?.nonce === nonce) await unlink(this.lockPath)
    }
  }

  async dispose(): Promise<void> { this.disposed = true; await this.queue.catch(() => {}) }
}
