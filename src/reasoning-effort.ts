import type { CatalogModel } from './model-catalog-types.ts'

// Responses wire values, not Codex agent modes. model/list also includes aliases
// such as ultra but does not expose the model-specific mapping needed to run them.
const wireEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function isSupportedReasoningEffort(value: string): boolean {
  return wireEfforts.has(value)
}

/** Keep catalog capabilities within the installed transport's contract. Never pick a fallback. */
export function compatibleReasoning(model: CatalogModel): CatalogModel {
  const excluded = [...new Set([
    ...(model.unsupportedReasoningEfforts ?? []),
    ...model.supportedReasoningEfforts.filter(option => !isSupportedReasoningEffort(option.reasoningEffort)).map(option => option.reasoningEffort),
  ])]
  const supported = model.supportedReasoningEfforts.filter(option => isSupportedReasoningEffort(option.reasoningEffort))
  const invalidDefault = model.defaultReasoningEffort !== null && !supported.some(option => option.reasoningEffort === model.defaultReasoningEffort)
    ? model.defaultReasoningEffort : model.unsupportedDefaultReasoningEffort
  return {
    ...model,
    supportedReasoningEfforts: supported,
    defaultReasoningEffort: invalidDefault ? null : model.defaultReasoningEffort,
    ...(excluded.length ? { unsupportedReasoningEfforts: excluded } : {}),
    ...(invalidDefault ? { unsupportedDefaultReasoningEffort: invalidDefault } : {}),
  }
}
