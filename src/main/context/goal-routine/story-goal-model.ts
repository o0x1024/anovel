import { withWorkModelOptions, type WorkModelOptions } from '../../../shared/work-model-options'
import { stepAcceptsWorkBodySlotModel } from '../../../shared/step-model-config'
import type { ModelRequest } from '../../model/types'
import type { StoryGoalConfig } from './story-goal-checker'

const loopModelOpts = new Map<number, WorkModelOptions>()

export function storyGoalModelOpts(
  config: Pick<StoryGoalConfig, 'modelType' | 'modelName' | 'thinkingEnabled'>
): WorkModelOptions {
  return {
    ...(config.modelType ? { modelType: config.modelType, modelName: config.modelName } : {}),
    ...(config.thinkingEnabled !== undefined ? { thinkingEnabled: config.thinkingEnabled } : {})
  }
}

export function extractStoryGoalModelPatch(
  partial: Partial<StoryGoalConfig>
): Partial<Pick<StoryGoalConfig, 'modelType' | 'modelName' | 'thinkingEnabled' | 'diagnoseBodyAfterGeneration'>> {
  const patch: Partial<Pick<StoryGoalConfig, 'modelType' | 'modelName' | 'thinkingEnabled' | 'diagnoseBodyAfterGeneration'>> = {}
  if (partial.modelType !== undefined) patch.modelType = partial.modelType
  if (partial.modelName !== undefined) patch.modelName = partial.modelName
  if (partial.thinkingEnabled !== undefined) patch.thinkingEnabled = partial.thinkingEnabled
  if (partial.diagnoseBodyAfterGeneration !== undefined) {
    patch.diagnoseBodyAfterGeneration = partial.diagnoseBodyAfterGeneration
  }
  return patch
}

export function bindGoalLoopModelOpts(workId: number, config: StoryGoalConfig): WorkModelOptions {
  const opts = storyGoalModelOpts(config)
  loopModelOpts.set(workId, opts)
  return opts
}

export function clearGoalLoopModelOpts(workId: number): void {
  loopModelOpts.delete(workId)
}

export function getGoalLoopModelOpts(workId: number): WorkModelOptions {
  return loopModelOpts.get(workId) ?? {}
}

export function withGoalLoopModelOptions<T extends ModelRequest>(workId: number, request: T): T {
  const opts = getGoalLoopModelOpts(workId)
  if (stepAcceptsWorkBodySlotModel(request.step)) {
    return withWorkModelOptions(request, opts)
  }
  if (opts.thinkingEnabled !== undefined) {
    return { ...request, thinkingEnabled: opts.thinkingEnabled }
  }
  return request
}
