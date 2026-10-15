import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexRpc, type RpcTransport } from './codex-rpc.ts'
import type { AccountView, ResetOperation, SubscriptionView } from './shared.ts'
import { parseUsage, record, usageAccountId } from './usage.ts'

export interface SubscriptionConfig {
  codexPath: string
  codexHome: string
  pollIntervalMs: number
  requestTimeoutMs: number
}

interface Credentials { accessToken: string; accountId: string; expiresAt: number }
interface Journal { version: 1; accountId: string; operation: ResetOperation }
const UNCERTAIN = '重置结果尚未确认。请重试同一次操作；不会生成新的兑换请求。'
const OUTCOMES = new Set(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'])

function isPending(operation: ResetOperation): boolean {
  return operation.status === 'uncertain' || (operation.status === 'prepared' && (operation.expiresAt ?? Infinity) > Date.now())
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(left) === normalize(right)
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : 'OpenAI 订阅请求失败'
  return value.replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_.-]{20,}/g, '[redacted]').slice(0, 600)
}

/** Account operations and credentials stay in the DSH Host, behind one dedicated Codex home. */
export class SubscriptionService {
  private readonly rpc: RpcTransport
  private readonly home: string
  private readonly journalPath: string
  private readonly lockPath: string
  private state: SubscriptionView = { account: null, usage: null, stale: true, error: null, login: null, operation: null }
  private listeners = new Set<(view: SubscriptionView) => void>()
  private accountId: string | null = null
  private epoch = 0
  private queue: Promise<unknown> = Promise.resolve()
  private refreshing: Promise<SubscriptionView> | null = null
  private tokenRequest: Promise<string> | null = null
  private disposed = false
  private disposal: Promise<void> | null = null
  private disposalComplete = false
  private lockNonce: string | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private scheduled: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: () => void

  constructor(private readonly config: SubscriptionConfig, rpc?: RpcTransport) {
    this.home = resolve(config.codexHome)
    if (samePath(this.home, join(homedir(), '.codex')) || (process.env.CODEX_HOME && samePath(this.home, process.env.CODEX_HOME))) {
      throw new Error('插件必须使用独立的 Codex 数据目录，不能使用已有 Codex 登录目录')
    }
    if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1000) throw new Error('Codex 请求超时必须至少为 1000 毫秒')
    if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1000) throw new Error('额度刷新间隔必须至少为 1000 毫秒')
    this.journalPath = join(this.home, 'dsh-reset-operation.json')
    this.lockPath = join(this.home, 'dsh-account.lock')
    this.rpc = rpc ?? new CodexRpc({ ...config, codexHome: this.home })
    this.unsubscribe = this.rpc.subscribe((method, params) => this.notification(method, params))
    this.poll = setInterval(() => { if (!this.state.login) this.notifyAfterRequest() }, config.pollIntervalMs)
    this.poll.unref()
  }

  snapshot(): SubscriptionView { return structuredClone(this.state) }

  subscribe(listener: (view: SubscriptionView) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(): SubscriptionView {
    const view = this.snapshot()
    for (const listener of this.listeners) { try { listener(view) } catch { /* display observers are isolated */ } }
    return view
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.disposed) throw new Error('OpenAI 订阅服务已停止')
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }

  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (error) {
      this.state.stale = true
      this.state.error = this.state.operation?.status === 'uncertain' ? `${UNCERTAIN} ${errorText(error)}` : errorText(error)
      this.publish()
      throw error
    }
  }

  refresh(): Promise<SubscriptionView> {
    if (!this.refreshing) {
      this.refreshing = this.run(() => this.guarded(() => this.withLock(() => this.refreshUnlocked())))
        .finally(() => { this.refreshing = null })
    }
    return this.refreshing
  }

  /** Pi inference runs outside app-server, so explicitly refresh when a DSH request ends. */
  notifyAfterRequest(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      void this.refresh().catch(() => {})
    }, 250)
    this.scheduled.unref()
  }

  private notification(method: string, params: unknown): void {
    if (this.disposed) return
    if (method === 'account/login/completed') {
      const event = record(params)
      if (!this.state.login || event?.loginId !== this.state.login.id) return
      this.state.login = null
      this.state.error = event.success === true ? null : 'ChatGPT 登录未完成，请重试'
      this.publish()
      if (event.success === true) this.notifyAfterRequest()
    } else if (method === 'account/updated' || method === 'account/rateLimits/updated') {
      // Rolling notifications are sparse; never replace a full snapshot with them.
      this.notifyAfterRequest()
    }
  }

  private async accountRead(refreshToken = false): Promise<Record<string, unknown>> {
    const result = record(await this.rpc.request('account/read', { refreshToken }))
    if (!result) throw new Error('Codex 返回了无法识别的账户数据')
    return result
  }

  private accountView(response: Record<string, unknown>): AccountView | null {
    if (response.account === null || response.account === undefined) return null
    const account = record(response.account)
    if (account?.type !== 'chatgpt') throw new Error('当前连接不是 ChatGPT 订阅登录，请在插件内重新登录')
    return {
      email: typeof account.email === 'string' ? account.email : null,
      planType: typeof account.planType === 'string' ? account.planType : null,
    }
  }

  private async credentials(): Promise<Credentials> {
    let auth: Record<string, unknown> | null
    try {
      const path = join(this.home, 'auth.json')
      if ((await stat(path)).size > 1024 * 1024) throw new Error('oversized')
      auth = record(JSON.parse(await readFile(path, 'utf8')))
    } catch { throw new Error('无法读取插件自己的 Codex 登录缓存，请重新登录；未使用其他来源的凭据') }
    const tokens = record(auth?.tokens)
    if (auth?.auth_mode !== 'chatgpt' || !tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.account_id !== 'string' || !tokens.account_id) {
      throw new Error('Codex 登录缓存格式不兼容或不属于 ChatGPT 订阅，请更新 Codex 后重新登录')
    }
    let claims: Record<string, unknown> | null
    try {
      const parts = tokens.access_token.split('.')
      if (parts.length !== 3) throw new Error('invalid')
      claims = record(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
    } catch { throw new Error('Codex 登录缓存中的访问令牌格式不兼容，请重新登录') }
    const tokenAccountId = record(claims?.['https://api.openai.com/auth'])?.chatgpt_account_id
    if (tokenAccountId !== tokens.account_id || typeof claims?.exp !== 'number' || !Number.isSafeInteger(claims.exp)) {
      throw new Error('登录令牌与 Codex 工作区不一致，无法安全使用该订阅；请重新登录')
    }
    return { accessToken: tokens.access_token, accountId: tokens.account_id, expiresAt: claims.exp * 1000 }
  }

  private bindAccount(response: Record<string, unknown>, credentials: Credentials): void {
    const account = this.accountView(response)
    if (!account) throw new Error('请先在 DSH 插件中登录 ChatGPT')
    const routingId = record(response.workspaceRouting)?.chatgptAccountId
    if (routingId !== undefined && routingId !== credentials.accountId) throw new Error('Codex 工作区路由与登录令牌不一致，请重新连接')
    if (this.accountId !== credentials.accountId) {
      this.epoch++
      this.state.usage = null
      this.accountId = credentials.accountId
    }
    this.state.account = account
  }

  private async refreshUnlocked(): Promise<SubscriptionView> {
    const journal = await this.readJournal()
    this.state.operation = journal?.operation ?? null
    if (this.state.login) return this.publish()
    const response = await this.accountRead()
    const account = this.accountView(response)
    if (!account) {
      if (this.accountId !== null) this.epoch++
      this.accountId = null
      this.state.account = null
      this.state.usage = null
      this.state.stale = false
      this.state.operation = journal && isPending(journal.operation) ? journal.operation : null
      this.state.error = journal?.operation.status === 'uncertain' ? UNCERTAIN : null
      return this.publish()
    }
    const credentials = await this.credentials()
    this.bindAccount(response, credentials)
    if (journal && isPending(journal.operation) && journal.accountId !== credentials.accountId) {
      throw new Error('存在属于另一工作区的待确认重置操作，请恢复原账户后重试')
    }
    if (journal && journal.accountId !== credentials.accountId) this.state.operation = null
    const currentEpoch = this.epoch
    const raw = await this.rpc.request('account/rateLimits/read', {})
    const usageId = usageAccountId(raw)
    if (usageId !== null && usageId !== credentials.accountId) throw new Error('返回的额度属于另一工作区，已拒绝显示或兑换')
    if (this.epoch !== currentEpoch || this.disposed) throw new Error('账户已变化，已丢弃旧额度响应')
    this.state.usage = parseUsage(raw)
    this.state.stale = false
    this.state.error = journal?.operation.status === 'uncertain' ? UNCERTAIN : null
    return this.publish()
  }

  login(): Promise<SubscriptionView> {
    return this.run(() => this.guarded(() => this.withLock(async () => {
      await this.assertCanSwitch()
      if (this.state.login) return this.snapshot()
      const result = record(await this.rpc.request('account/login/start', { type: 'chatgpt' }))
      if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') throw new Error('Codex 未返回有效的浏览器登录信息')
      let url: URL
      try { url = new URL(result.authUrl) } catch { throw new Error('Codex 登录地址无效') }
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Codex 返回了非官方登录地址，已拒绝打开')
      this.epoch++
      this.accountId = null
      this.state = { account: null, usage: null, stale: true, error: null, login: { id: result.loginId, url: result.authUrl }, operation: null }
      return this.publish()
    })))
  }

  cancelLogin(): Promise<SubscriptionView> {
    return this.run(() => this.guarded(() => this.withLock(async () => {
      const login = this.state.login
      if (login) await this.rpc.request('account/login/cancel', { loginId: login.id })
      this.state.login = null
      return this.refreshUnlocked()
    })))
  }

  logout(): Promise<SubscriptionView> {
    return this.run(() => this.guarded(() => this.withLock(async () => {
      await this.assertCanSwitch()
      if (this.state.login) await this.rpc.request('account/login/cancel', { loginId: this.state.login.id })
      await this.rpc.request('account/logout')
      this.epoch++
      this.accountId = null
      this.state = { account: null, usage: null, stale: false, error: null, login: null, operation: null }
      return this.publish()
    })))
  }

  private async assertCanSwitch(): Promise<void> {
    const journal = await this.readJournal()
    if (journal && isPending(journal.operation)) {
      this.state.operation = journal.operation
      throw new Error('重置操作尚未结束；请先确认原操作，或等待未提交的确认操作到期，再切换账户')
    }
  }

  accessToken(): Promise<string> {
    if (!this.tokenRequest) {
      this.tokenRequest = this.run(() => this.guarded(() => this.withLock(async () => {
        if (this.state.login) throw new Error('请先完成当前 ChatGPT 登录')
        let response = await this.accountRead()
        if (!this.accountView(response)) throw new Error('请先在 DSH 插件中登录 ChatGPT')
        let credentials = await this.credentials()
        this.bindAccount(response, credentials)
        const originalAccountId = credentials.accountId
        if (credentials.expiresAt <= Date.now() + 120_000) {
          response = await this.accountRead(true)
          credentials = await this.credentials()
          if (credentials.accountId !== originalAccountId) throw new Error('刷新过程中账户发生变化，已停止本次模型请求')
          this.bindAccount(response, credentials)
        }
        if (credentials.expiresAt <= Date.now() + 30_000) throw new Error('ChatGPT 访问令牌已过期且未能刷新，请重新登录')
        const journal = await this.readJournal()
        if (journal && isPending(journal.operation) && journal.accountId !== credentials.accountId) throw new Error('待确认重置操作与当前账户不一致，请恢复原账户')
        return credentials.accessToken
      }))).finally(() => { this.tokenRequest = null })
    }
    return this.tokenRequest
  }

  prepareReset(creditId: string | null): Promise<SubscriptionView> {
    return this.run(() => this.guarded(() => this.withLock(async () => {
      if (creditId !== null && (!creditId.trim() || creditId.length > 512)) throw new Error('重置卡标识无效')
      await this.refreshUnlocked()
      if (!this.accountId || !this.state.account || this.state.login) throw new Error('请先完成 ChatGPT 登录')
      const previous = await this.readJournal()
      if (previous && isPending(previous.operation)) {
        if (previous.accountId !== this.accountId || previous.operation.creditId !== creditId) throw new Error('已有待处理的重置操作，请先处理原操作')
        this.state.operation = previous.operation
        return this.publish()
      }
      const credits = this.state.usage?.resetCredits
      if (!credits || credits.availableCount <= 0) throw new Error('当前没有服务端确认可用的重置卡')
      if (creditId !== null && (!credits.credits || !credits.credits.some(credit => credit.id === creditId))) throw new Error('所选重置卡已失效或不在当前账户的可用列表中，请刷新')
      const operation: ResetOperation = { id: randomUUID(), creditId, expiresAt: Date.now() + 120_000, status: 'prepared', outcome: null }
      await this.saveJournal({ version: 1, accountId: this.accountId, operation })
      this.state.operation = operation
      this.state.error = null
      return this.publish()
    })))
  }

  consumeReset(operationId: string): Promise<SubscriptionView> {
    return this.run(() => this.guarded(() => this.withLock(async () => {
      const journal = await this.readJournal()
      if (!journal || journal.operation.id !== operationId) throw new Error('重置确认已失效，请重新准备；不会自动兑换其他重置卡')
      this.state.operation = journal.operation
      if (journal.operation.status === 'completed') return this.refreshUnlocked()
      if (journal.operation.status === 'prepared' && (journal.operation.expiresAt ?? 0) <= Date.now()) throw new Error('重置确认已过期，请重新确认')
      if (this.state.login) throw new Error('登录尚未完成，不能兑换重置卡')
      const response = await this.accountRead()
      const credentials = await this.credentials()
      this.bindAccount(response, credentials)
      if (credentials.accountId !== journal.accountId) throw new Error('账户已变化；此操作只能在原工作区重试')
      const rawUsage = await this.rpc.request('account/rateLimits/read', {})
      const quotaAccountId = usageAccountId(rawUsage)
      if (quotaAccountId !== null && quotaAccountId !== journal.accountId) throw new Error('额度工作区与重置操作不一致，已停止兑换')
      // Persist uncertainty BEFORE sending. A restart or timeout can only retry this same key.
      journal.operation = { ...journal.operation, status: 'uncertain', expiresAt: null }
      await this.saveJournal(journal)
      this.state.operation = journal.operation
      this.state.error = UNCERTAIN
      this.publish()
      const result = record(await this.rpc.request('account/rateLimitResetCredit/consume', {
        idempotencyKey: journal.operation.id,
        ...(journal.operation.creditId === null ? {} : { creditId: journal.operation.creditId }),
      }))
      if (typeof result?.outcome !== 'string' || !OUTCOMES.has(result.outcome)) throw new Error('服务端返回了未知重置结果，请使用原操作重试')
      journal.operation = { ...journal.operation, status: 'completed', outcome: result.outcome as ResetOperation['outcome'] }
      await this.saveJournal(journal)
      this.state.operation = journal.operation
      this.state.error = null
      // Never infer new quota windows or available cards from the redemption response.
      try { return await this.refreshUnlocked() }
      catch (error) {
        this.state.stale = true
        this.state.error = `重置结果已确认，但额度刷新失败：${errorText(error)}`
        return this.publish()
      }
    })))
  }

  private async readJournal(): Promise<Journal | null> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.journalPath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('本地重置记录无法读取，请保留该记录并修复后重试；已停止兑换')
    }
    const journal = record(value)
    const operation = record(journal?.operation)
    if (journal?.version !== 1 || typeof journal.accountId !== 'string' || !journal.accountId || !operation
      || typeof operation.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(operation.id)
      || (operation.creditId !== null && typeof operation.creditId !== 'string')
      || !['prepared', 'uncertain', 'completed'].includes(String(operation.status))
      || (operation.expiresAt !== null && (typeof operation.expiresAt !== 'number' || !Number.isSafeInteger(operation.expiresAt)))
      || (operation.outcome !== null && !OUTCOMES.has(String(operation.outcome)))
      || (operation.status === 'completed' ? operation.outcome === null : operation.outcome !== null)
      || (operation.status === 'prepared' && operation.expiresAt === null)) {
      throw new Error('本地重置记录格式不兼容，已停止兑换以防重复消耗')
    }
    return journal as unknown as Journal
  }

  private async saveJournal(journal: Journal): Promise<void> {
    const temporary = `${this.journalPath}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(journal), 'utf8'); await file.sync() }
      finally { await file.close() }
      await rename(temporary, this.journalPath)
    } finally { await unlink(temporary).catch(() => {}) }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    // The whole Host owns this home: browser login and server-side refresh can outlive an RPC.
    if (this.lockNonce) {
      const owner = await readFile(this.lockPath, 'utf8').then(value => record(JSON.parse(value))).catch(() => null)
      if (owner?.nonce !== this.lockNonce) throw new Error('账户目录锁已被外部更改，已停止访问；请重启 DSH')
      return action()
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 })
    const actual = await realpath(this.home)
    for (const forbidden of [join(homedir(), '.codex'), process.env.CODEX_HOME].filter((path): path is string => !!path)) {
      const forbiddenActual = await realpath(forbidden).catch(() => resolve(forbidden))
      if (samePath(actual, forbiddenActual)) throw new Error('插件数据目录指向已有 Codex 登录目录，已停止访问')
    }
    const nonce = randomUUID()
    let acquired = false
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      try {
        const lock = await open(this.lockPath, 'wx', 0o600)
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, nonce }), 'utf8'); await lock.sync(); acquired = true }
        finally { await lock.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let existing: Record<string, unknown> | null = null
        try { existing = record(JSON.parse(await readFile(this.lockPath, 'utf8'))) } catch { /* retain ambiguous lock */ }
        if (!existing || typeof existing.pid !== 'number' || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(existing.nonce)) throw new Error('账户锁记录不完整，请关闭其他 DSH 进程后检查插件数据目录')
        let alive = true
        try { process.kill(existing.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
        if (alive) throw new Error('另一 DSH Host 正在使用此订阅目录，请关闭它或为当前 Host 配置独立 dataDirectory')
        // Only one reclaimer may inspect/remove a given dead owner's file. This
        // prevents concurrent stale-lock recovery from deleting a new owner's lock.
        const reclaim = `${this.lockPath}.${existing.nonce}.reclaim`
        try { await mkdir(reclaim, { mode: 0o700 }) }
        catch { throw new Error('另一进程正在恢复账户锁，请稍后重试') }
        try {
          const latest = record(JSON.parse(await readFile(this.lockPath, 'utf8')))
          if (latest?.nonce === existing.nonce) await unlink(this.lockPath)
        } finally { await rmdir(reclaim).catch(() => {}) }
      }
    }
    if (!acquired) throw new Error('无法取得账户操作锁，请稍后重试')
    this.lockNonce = nonce
    return action()
  }

  async dispose(): Promise<void> {
    if (this.disposalComplete) return
    if (this.disposal) return this.disposal
    this.disposed = true
    if (this.poll) clearInterval(this.poll)
    if (this.scheduled) clearTimeout(this.scheduled)
    this.unsubscribe()
    this.listeners.clear()
    this.disposal = (async () => {
      // A failed shutdown leaves both the RPC process reference and this lock intact.
      // A later dispose() can retry; a second Host must not share the live auth cache.
      await this.rpc.dispose()
      await this.queue.catch(() => {})
      const current = await readFile(this.lockPath, 'utf8').then(value => record(JSON.parse(value))).catch(() => null)
      if (this.lockNonce && current?.nonce === this.lockNonce) await unlink(this.lockPath)
      this.lockNonce = null
      this.disposalComplete = true
    })().finally(() => { this.disposal = null })
    return this.disposal
  }
}
