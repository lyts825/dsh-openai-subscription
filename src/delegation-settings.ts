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

function parseRoute(value: unknown): DelegationRoute | null {
  if (value === null) return null
  const route = object(value)
  if (!route || !exactKeys(route, ['provider', 'model']) || !routeText(route.provider) || !routeText(route.model)) {
    throw new DelegationSettingsError('委派模型必须是有效的 provider/model 路由。', 'invalid')
  }
  return { provider: route.provider, model: route.model }
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
      return models.flatMap(model => {
        const target = familyOf(provider.id, model.id)
        return target && routeText(provider.id) && routeText(model.id)
          ? [{ provider: provider.id, providerName: provider.name, model: model.id, modelName: model.name, target }]
          : []
      })
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
      for (const candidate of result.value) {
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
          if (route && catalog.catalogFailures.some(failure => failure.provider === route.provider)) {
            throw new DelegationSettingsError('所选提供方的模型目录暂时不可用，请稍后重试。', 'unavailable')
          }
          if (!route || !catalog.candidates.some(candidate => candidate.target === target
            && candidate.provider === route.provider && candidate.model === route.model)) {
            throw new DelegationSettingsError(`${target === 'ds' ? 'DeepSeek' : 'GPT'} 模型不在当前目录中，请重新选择。`, 'invalid')
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
