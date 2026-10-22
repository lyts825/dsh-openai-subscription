/** Session-owned DS/GPT delegation over DSH's native continuable children. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import { parseDelegationPolicy } from './delegation-settings.ts'
import { defaultDelegationPolicy, type DelegationPolicy, type DelegationTarget } from './delegation-shared.ts'

const toolNames = { ds: 'delegate_to_deepseek', gpt: 'delegate_to_gpt' } as const
// These are the child-creation entry points shipped by DSH 0.2.0-rc.2.
// Existing child messaging, interruption, listing, and job collection stay available.
const unmanagedCreationTools = new Set([
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'workflow', 'ralph', 'spawn_teammate',
])
const policySchema = z.custom<DelegationPolicy>(value => {
  try { parseDelegationPolicy(value); return true }
  catch { return false }
}, 'Invalid persisted delegation policy')
function sessionDomain(sessionId: SessionId) {
  // Single layout rejects incompatible/malformed state. Per-record is a cache
  // layout that may treat an unreadable record as absent, which is unsafe here.
  // Each Session owns a separate file: Hosts sharing DSH_HOME must not rewrite
  // each other's unrelated policies from independent whole-domain caches.
  return defineDomain({
    name: `openai_delegation_${createHash('sha256').update(sessionId).digest('hex')}`, version: 1,
    tables: { sessions: domainTable<SessionId, DelegationPolicy>(policySchema) },
  })
}
type OwnedFiber = Awaited<ReturnType<Context['inject']>>

/** Install one immutable policy in the Agent's own scope. */
function mountPolicy(agent: Agent, policy: DelegationPolicy): OwnedFiber | undefined {
  if (!policy.enabled) return
  return agent.ctx.inject(subagentTool.inject, scoped => {
    const targets: DelegationTarget[] = policy.mode === 'auto' ? ['ds', 'gpt'] : [policy.manualTarget]
    const allowed = new Set<string>(targets.map(target => toolNames[target]))
    const blocked = (name: string) => unmanagedCreationTools.has(name)
      || (Object.values(toolNames).some(candidate => candidate === name) && !allowed.has(name))
    const routes = targets.map(target => {
      const route = policy[target]
      // The stored-policy parser guarantees the active route exists.
      if (!route) throw new Error('Enabled delegation policy has no selected route')
      subagentTool.apply(scoped, {
        provider: 'spawn', toolName: toolNames[target], modelSelectionSettings: false,
        backgroundMode: 'continuable', agentOptions: {
          provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
        },
      }, agent.session)
      return `${toolNames[target]}: ${route.provider}/${route.model}; reasoning effort: ${route.reasoningEffort === undefined
        ? 'DSH default (may inherit the current parent effort for the same route; a changed route uses the target model default)'
        : `fixed ${route.reasoningEffort}`}`
    })
    scoped.tools.guard(exec => blocked(exec.name)
      ? `This conversation uses fixed delegation routes. Create children with ${[...allowed].join(' or ')}; ${exec.name} is disabled for this conversation.`
      : undefined)
    scoped.systemPrompt.section({
      name: 'openai-subscription:delegation-routing',
      order: scoped.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      interpolate: false,
      text: `Delegation routes for this conversation: ${routes.join('; ')}. ${policy.mode === 'auto'
        ? 'Choose the appropriate delegation tool for each task.'
        : 'The user has fixed the child model; use only the listed delegation tool.'} Each tool starts a fresh child with that exact model and inherits DSH permissions and cancellation. Do not supply provider, model, or reasoning_effort overrides. Other child-creation tools (${[...unmanagedCreationTools].join(', ')}) are disabled. Existing child control tools remain available.`,
    })
    scoped.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      assembly.tools = assembly.tools.filter(tool => !blocked(tool.name))
      assembly.sections = assembly.sections.filter(section => !section.name.startsWith('tool:') || !blocked(section.name.slice(5)))
      return assembly
    })
  })
}

/**
 * Capture defaults only for newly created Sessions. Stored policies survive
 * restart; children inherit their parent's captured policy. The native runtime
 * continues to own child routes, permissions, catalogs, cancellation and resume.
 */
export async function installDelegationRuntime(ctx: Context, policy: () => DelegationPolicy): Promise<void> {
  await ctx.inject(['agents', 'storageDomain', 'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'sessionPersistence', 'sessionQuery'], async owner => {
    const installed = new Map<Agent, Promise<OwnedFiber | undefined>>()
    const policies = new Map<SessionId, Promise<DelegationPolicy | undefined>>()
    const retired = new WeakSet<Agent>()
    let stopping = false
    let loading = true
    let loadFailure: string | undefined
    // A failed reload must not expose the unguarded native creation tools to
    // already-live Agents whose persisted routing policy cannot be inspected.
    owner.tools.guard(exec => {
      const unavailable = loadFailure ?? (loading ? 'Conversation delegation policies are loading. Retry after loading completes.' : undefined)
      return unavailable !== undefined
        && (unmanagedCreationTools.has(exec.name) || Object.values(toolNames).some(name => name === exec.name))
        ? unavailable : undefined
    })

    const load = (id: SessionId, initial?: () => Promise<DelegationPolicy | undefined>): Promise<DelegationPolicy | undefined> => {
      const existing = policies.get(id)
      if (existing) return existing
      const pending = (async () => {
        const domain = await owner.storageDomain.open(sessionDomain(id))
        try {
          const table = domain.table('sessions')
          const stored = table.get(id)
          if (stored) return parseDelegationPolicy(stored)
          const captured = await initial?.()
          if (captured) await table.put(id, captured)
          return captured
        } finally { await domain.close() }
      })()
      policies.set(id, pending)
      return pending
    }

    const install = (agent: Agent, created: boolean): Promise<OwnedFiber | undefined> => {
      const existing = installed.get(agent)
      if (existing) return existing
      // Capture synchronous settings before storage IO so a later settings save
      // cannot change the policy of a conversation already being published.
      const fresh = created && agent.session.firstLiveSeq === 0
        && agent.session.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
      const configured = fresh && agent.session.header.origin !== 'subagent' ? parseDelegationPolicy(policy()) : undefined
      const inactive = () => stopping || retired.has(agent) || agent.ctx.fiber.uid === null
      const pending = (async () => {
        if (inactive()) return
        const captured = await load(agent.id, async () => {
          if (!fresh) return
          const parent = agent.session.header.origin === 'subagent' ? agent.session.header.parentSession : undefined
          return parseDelegationPolicy(parent ? await load(parent) ?? defaultDelegationPolicy() : configured ?? defaultDelegationPolicy())
        })
        if (inactive() || !captured) return
        let fiber: OwnedFiber | undefined
        try {
          fiber = mountPolicy(agent, parseDelegationPolicy(captured))
          await fiber?.await()
        } catch (error) {
          await fiber?.dispose()
          // A child may finish while HMR restores its policy. Cancellation of
          // that Agent's mounting scope must not disable unrelated Sessions.
          // Storage errors above still reach the fail-closed handler below.
          if (inactive()) return
          throw error
        }
        if (inactive()) { await fiber?.dispose(); return }
        return fiber
      })().catch(error => {
        loadFailure = 'Conversation delegation policy could not be loaded. Child creation is disabled; repair the stored policy and reload the plugin.'
        owner.logger.error(`${loadFailure} ${String(error)}`)
        throw error
      })
      installed.set(agent, pending)
      return pending
    }

    owner.on('agent/created', async ({ agent }) => { await install(agent, true) })
    owner.on('agent/disposed', ({ agent }) => {
      retired.add(agent)
      const pending = installed.get(agent)
      installed.delete(agent)
      void pending?.then(fiber => fiber?.dispose()).catch(error => owner.logger.warn(String(error)))
    })
    // Reattach policies on HMR without applying current defaults to old Sessions.
    const startup = Promise.all(owner.agents.list().map(agent => install(agent, false)))
    owner.effect(() => async () => {
      stopping = true
      const entries = await Promise.allSettled(installed.values())
      installed.clear()
      await Promise.all(entries.map(entry => entry.status === 'fulfilled' ? entry.value?.dispose() : undefined))
      await Promise.allSettled(policies.values())
      policies.clear()
    }, 'openaiSubscription.delegationSessions()')
    try { await startup }
    catch { /* install() retained the fail-closed guard and reported the failed record. */ }
    finally { loading = false }
  }).await()
}
