export function assertNovelGoalNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

export { countWords as countNovelWords } from '../../../shared/body-word-target'
