import type { RpcTransport } from './codex-rpc.ts'
import type { CatalogModel, ModelCatalogView } from './model-catalog-types.ts'
import { record } from './usage.ts'

export type { CatalogModel, ModelCatalogView } from './model-catalog-types.ts'
export const CATALOG_REFRESH_MS = 15 * 60_000

export function emptyModelCatalog(revision = 0): ModelCatalogView {
  return { models: [], revision, updatedAt: null, stale: true, refreshing: false, error: null, source: 'unavailable', remoteVerified: false }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Parse only the stable model/list fields, retaining exact model and effort ids. */
export function parseCatalogModel(value: unknown): CatalogModel | null {
  const entry = record(value)
  if (!entry || !boundedString(entry.model, 256)) throw new Error('Codex 模型目录包含无效模型标识')
  if (entry.hidden === true) return null
  // DSH's current text adapter cannot represent audio-only entries. Older Codex
  // versions omitted modalities; the official backwards-compatible default is text+image.
  const modalities = entry.inputModalities === undefined ? ['text', 'image'] : entry.inputModalities
  if (!Array.isArray(modalities)) throw new Error('Codex 模型目录中的输入能力无效')
  if (!modalities.includes('text')) return null
  const inputModalities = ['text', 'image'].filter(value => modalities.includes(value)) as CatalogModel['inputModalities']
  if (!Array.isArray(entry.supportedReasoningEfforts) || entry.supportedReasoningEfforts.length > 64) throw new Error('Codex 模型目录缺少有效推理能力信息')
  const efforts = entry.supportedReasoningEfforts.map(value => {
    const option = record(value)
    if (!option || !boundedString(option.reasoningEffort, 64)) throw new Error('Codex 模型目录中的推理档位无效')
    return { reasoningEffort: option.reasoningEffort, description: typeof option.description === 'string' ? option.description.slice(0, 2000) : '' }
  }).filter((value, index, all) => all.findIndex(other => other.reasoningEffort === value.reasoningEffort) === index)
  const defaultEffort = typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort : null
  if (defaultEffort && efforts.length && !efforts.some(value => value.reasoningEffort === defaultEffort)) throw new Error('Codex 模型目录的默认推理档位不在支持列表中')
  return {
    id: entry.model,
    displayName: boundedString(entry.displayName, 512) ? entry.displayName : entry.model,
    description: typeof entry.description === 'string' ? entry.description.slice(0, 4000) : '',
    isDefault: entry.isDefault === true,
    inputModalities,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: efforts.length ? defaultEffort : null,
    upgrade: boundedString(entry.upgrade, 256) ? entry.upgrade : null,
  }
}

/** A full traversal is atomic: partial/looping pages never replace a usable snapshot. */
export async function readModelCatalog(rpc: RpcTransport): Promise<CatalogModel[]> {
  const entries = new Map<string, CatalogModel>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = record(await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }))
    if (!response || !Array.isArray(response.data) || response.data.length > 1000) throw new Error('Codex 返回了无法识别的模型目录')
    for (const value of response.data) {
      const model = parseCatalogModel(value)
      if (model && !entries.has(model.id)) entries.set(model.id, model)
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      // Stable default-first order; retain Codex's ordering for all other entries.
      return [...entries.values()].sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
    }
    if (!boundedString(response.nextCursor, 4096) || seenCursors.has(response.nextCursor)) throw new Error('Codex 模型目录分页未能正常结束')
    cursor = response.nextCursor
    seenCursors.add(cursor)
  }
  throw new Error('Codex 模型目录超过安全分页上限')
}
