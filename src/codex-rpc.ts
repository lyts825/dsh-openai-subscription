import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { record } from './usage.ts'

export interface CodexRpcConfig {
  codexPath: string
  codexHome: string
  requestTimeoutMs: number
}

export interface RpcTransport {
  request(method: string, params?: unknown): Promise<unknown>
  subscribe(listener: (method: string, params: unknown) => void): () => void
  dispose(): Promise<void>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Dedicated account-only Codex process. No shell or agent turns are invoked. */
export class CodexRpc implements RpcTransport {
  private process: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private starting = false
  private disposed = false
  private disposal: Promise<void> | null = null
  private disposalComplete = false
  private closedChildren = new WeakSet<ChildProcessWithoutNullStreams>()
  private stopping = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(method: string, params: unknown) => void>()

  constructor(private readonly config: CodexRpcConfig) {}

  subscribe(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.disposed) throw new Error('OpenAI 订阅服务已停止')
    if (this.ready && !this.process && !this.starting) this.ready = null
    if (!this.ready) {
      this.starting = true
      this.ready = this.start()
        .finally(() => { this.starting = false })
        .catch(error => { this.ready = null; throw error })
    }
    await this.ready
    return this.sendRequest(method, params)
  }

  private async start(): Promise<void> {
    await mkdir(this.config.codexHome, { recursive: true, mode: 0o700 })
    if (this.disposed) throw new Error('OpenAI 订阅服务已停止')
    // A failed initialization may leave a process whose shutdown was not confirmed.
    // Retain that process and finish stopping it before ever spawning its replacement.
    if (this.process) {
      const previous = this.process
      await this.stopChild(previous, true)
      if (this.process === previous) this.process = null
    }
    if (this.disposed) throw new Error('OpenAI 订阅服务已停止')
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.config.codexHome }
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key]
    const child = spawn(this.config.codexPath, [
      'app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"',
    ], { cwd: this.config.codexHome, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = child
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.process !== child) return
      buffered += chunk
      if (buffered.length > 4 * 1024 * 1024) {
        this.fail(new Error('Codex app-server 响应超过协议大小限制'))
        child.kill()
        return
      }
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) this.receive(line, child)
      }
    })
    // Drain diagnostics without exposing OAuth URLs or credentials to logs or the UI.
    child.stderr.resume()
    child.stdin.on('error', () => {
      if (this.process === child) this.fail(new Error('Codex app-server 输入连接已关闭'))
    })
    child.on('error', () => {
      if (this.process !== child) return
      this.fail(new Error('无法启动 Codex CLI；请检查可执行文件路径'))
    })
    child.on('exit', (code, signal) => {
      if (this.process !== child) return
      this.fail(new Error(`Codex app-server 已退出（${code ?? signal ?? 'unknown'}）`))
    })
    child.once('close', () => {
      this.closedChildren.add(child)
      if (this.process === child) this.process = null
    })
    try {
      await this.sendRequest('initialize', { clientInfo: { name: 'dsh_openai_subscription', title: 'DSH OpenAI Subscription', version: '0.2.0-rc.1' } })
      this.write({ method: 'initialized', params: {} })
    } catch (error) {
      await this.stopChild(child, true)
      if (this.process === child) this.process = null
      throw error
    }
  }

  private write(message: unknown): void {
    if (!this.process || this.process.stdin.destroyed || !this.process.stdin.writable) throw new Error('Codex app-server 连接不可用')
    const child = this.process
    child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error && this.process === child) this.fail(new Error('Codex app-server 连接写入失败')) })
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex 请求超时：${method}`))
      }, this.config.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, ...(params === undefined ? {} : { params }) }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  private receive(line: string, child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return
    let message: Record<string, unknown> | null
    try { message = record(JSON.parse(line)) }
    catch { message = null }
    if (!message) { this.fail(new Error('Codex app-server 返回了无效 JSON')); child.kill(); return }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // This integration never grants server-side tool or external-token requests.
        try { this.write({ id: message.id, error: { code: -32601, message: 'Unsupported by the DSH account client' } }) }
        catch { this.fail(new Error('Codex app-server 连接已关闭')) }
        return
      }
      for (const listener of this.listeners) { try { listener(message.method, message.params) } catch { /* observers cannot break RPC */ } }
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    const error = record(message.error)
    if (error) {
      // Upstream diagnostics can contain credentials or callback URLs. Expose codes only.
      const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : 'unknown'
      const detail = code === -32601 ? '此版本 Codex 不支持该操作，请更新插件附带的 Codex' : 'Codex 服务拒绝了请求，请检查登录状态后重试'
      pending.reject(new Error(`${detail}（代码 ${code}）`))
    } else pending.resolve(message.result)
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  private async stopChild(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
    if (this.closedChildren.has(child)) return
    const existing = this.stopping.get(child)
    if (existing) return existing
    const stopping = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (confirmed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(termTimer)
        clearTimeout(killTimer)
        clearTimeout(deadline)
        child.removeListener('close', onClose)
        if (confirmed) {
          this.closedChildren.add(child)
          resolve()
        } else {
          reject(new Error('无法确认 Codex 进程已关闭，已保留账户目录锁；请关闭该进程后重试停止服务'))
        }
      }
      const signal = (value: NodeJS.Signals) => { try { child.kill(value) } catch { /* only close confirms shutdown */ } }
      const onClose = () => finish(true)
      const termTimer = setTimeout(() => signal('SIGTERM'), 500)
      const killTimer = setTimeout(() => signal('SIGKILL'), 1250)
      const deadline = setTimeout(() => finish(false), 3000)
      child.once('close', onClose)
      try { child.stdin.end() } catch { /* escalation still runs */ }
      if (force) signal('SIGTERM')
    })
    this.stopping.set(child, stopping)
    try { await stopping }
    finally { if (this.stopping.get(child) === stopping) this.stopping.delete(child) }
  }

  async dispose(): Promise<void> {
    if (this.disposalComplete) return
    if (this.disposal) return this.disposal
    this.disposed = true
    this.fail(new Error('OpenAI 订阅服务已停止'))
    this.listeners.clear()
    this.disposal = (async () => {
      const startup = this.ready
      const child = this.process
      if (child) {
        await this.stopChild(child, false)
        if (this.process === child) this.process = null
      }
      // A startup already awaiting mkdir/initialization must settle before the home is unlocked.
      await startup?.catch(() => {})
      if (this.process) {
        const remaining = this.process
        await this.stopChild(remaining, true)
        if (this.process === remaining) this.process = null
      }
      this.disposalComplete = true
    })().finally(() => { this.disposal = null })
    return this.disposal
  }
}
