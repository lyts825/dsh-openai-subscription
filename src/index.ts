import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema, type ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import { Config, runtimePaths, type Options } from './config.ts'
import { SubscriptionService } from './subscription.ts'
import { createSubscriptionAdapter } from './provider.ts'
import { RPC_CHANNEL, RPC_PREFIX, PROVIDER_ID } from './shared.ts'

export { Config } from './config.ts'
export const name = 'openai-subscription'
export const inject = ['llm']

/** Only these human-facing actions are available through DSH's authenticated Connection. */
const actions = new Set(['state', 'refresh', 'login', 'cancelLogin', 'logout', 'prepareReset', 'consumeReset'])
const MAX_RPC_BODY_BYTES = 16 * 1024

/** Register the provider and its settings operations; disposing the plugin closes its child process. */
export function apply(ctx: Context, input: Options): void {
  const config = Config(input)
  const service = new SubscriptionService({ ...runtimePaths(config), pollIntervalMs: config.pollIntervalMs, requestTimeoutMs: config.requestTimeoutMs })
  ctx.effect(() => () => service.dispose())
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], createSubscriptionAdapter(ctx, service, config)))
  ctx.inject(['connection'], child => {
    const handle = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcHandlerResult> => {
      const action = endpoint.slice(RPC_PREFIX.length)
      if (!endpoint.startsWith(RPC_PREFIX) || !actions.has(action)) return { ok: false, error: { code: 'subscription/unknown-action', message: 'Unknown subscription action.', details: {} } }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return badRequest()
      const data = payload as Record<string, unknown>
      const expected = action === 'prepareReset' ? ['creditId'] : action === 'consumeReset' ? ['operationId'] : []
      if (Object.keys(data).length !== expected.length || Object.keys(data).some(key => !expected.includes(key))) return badRequest()
      if (signal.aborted) return { ok: false, error: { code: 'gateway/cancelled', message: 'Request cancelled.', details: {} } }
      try {
        switch (action) {
          case 'state': return { ok: true, value: service.snapshot() }
          case 'refresh': return { ok: true, value: await service.refresh() }
          case 'login': return { ok: true, value: await service.login() }
          case 'cancelLogin': return { ok: true, value: await service.cancelLogin() }
          case 'logout': return { ok: true, value: await service.logout() }
          case 'prepareReset':
            if (data.creditId !== null && (typeof data.creditId !== 'string' || !data.creditId || data.creditId.length > 256)) return badRequest()
            return { ok: true, value: await service.prepareReset(data.creditId) }
          case 'consumeReset':
            if (typeof data.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.operationId)) return badRequest()
            return { ok: true, value: await service.consumeReset(data.operationId) }
          default: return badRequest()
        }
      } catch {
        // Detailed transport/provider failures stay in the service's safe display state.
        return { ok: false, error: { code: 'subscription/failed', message: service.snapshot().error ?? '操作失败，请刷新状态后重试。 / Operation failed; refresh before retrying.', details: {} } }
      }
    }
    // Gateway owns the sole /api interceptor. Exact routes share Connection's
    // authentication and body cap without claiming Gateway's dispatch slot.
    for (const action of actions) {
      const endpoint = RPC_PREFIX + action
      child.effect(() => child.connection.fetch.register({
        path: `${RPC_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
        fetch: request => dispatchRpc(request, endpoint, handle),
      }))
    }
  })
}

/** Decode the native Connection envelope only after Connection admits the request. */
async function dispatchRpc(
  request: Request,
  endpoint: string,
  handle: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcHandlerResult>,
): Promise<Response> {
  let rpcId = 'invalid-request'
  const respond = (result: ConnectionRpcHandlerResult, status = 200) => Response.json({ type: 'server-response', rpcId, result }, { status })
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return respond(badRequest(), 415)
  }
  if (Number(request.headers.get('content-length')) > MAX_RPC_BODY_BYTES) return respond(badRequest(), 413)
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_RPC_BODY_BYTES) return respond(badRequest(), 413)
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { return respond(badRequest()) }
  if (body && typeof body === 'object' && 'rpcId' in body && typeof body.rpcId === 'string') rpcId = body.rpcId
  const message = clientRequestSchema.safeParse(body)
  if (!message.success || message.data.method !== endpoint) return respond(badRequest())
  return respond(await handle(endpoint, message.data.payload, request.signal))
}

function badRequest() {
  return { ok: false as const, error: { code: 'gateway/bad-request', message: 'Invalid subscription request.', details: {} } }
}
