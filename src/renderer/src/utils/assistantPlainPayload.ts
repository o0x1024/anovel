import type { AssistantWorkReference } from '../../../shared/assistant-types'

/** IPC structured clone 不接受 Vue Proxy，发送前转为纯对象。 */
export function toPlainWorkReferences(
  refs: AssistantWorkReference[]
): AssistantWorkReference[] {
  return refs.map(ref => ({
    workId: Number(ref.workId),
    chapterId: ref.chapterId == null ? null : Number(ref.chapterId),
    title: String(ref.title)
  }))
}

export function toPlainDocumentIds(ids: number[]): number[] {
  return ids.map(id => Number(id))
}
