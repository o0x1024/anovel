import { ref, unref } from 'vue'
import { toPlainForIpc } from '../../../../shared/ipc-plain'
import type { IncubatorAdoptMode } from '../../../../shared/incubator-types'
import type { IncubatorSlotKey } from '../../../../shared/incubator-slots'
import { reportRendererError } from '../../utils/reportError'

export type AdoptSourceStep = 'variants' | 'expand' | 'premise_gen' | 'role_engine_gen' | 'world_rules_gen' | 'rhythm_curve_gen' | 'ending_gen'

export interface AdoptLegacyPayload {
  sourceStep: AdoptSourceStep
  title: string
  summary: string
  dimension?: string | null
  highlights?: string | null
  audience?: string | null
}

export function useStorylineAdopt(workId: number, onSuccess: () => Promise<void>) {
  const modalOpen = ref(false)
  const adopting = ref(false)
  const adoptError = ref('')
  const payload = ref<AdoptLegacyPayload | null>(null)
  const candidateId = ref<number | null>(null)
  const candidateFinalScore = ref<number | null>(null)
  const slotKey = ref<IncubatorSlotKey>('opening')
  const mode = ref<IncubatorAdoptMode>('append_slot')

  const adoptModeOptions: { value: IncubatorAdoptMode; label: string }[] = [
    { value: 'append_slot', label: '合并进槽位（推荐）' },
    { value: 'replace_slot', label: '替换槽位内容' },
    { value: 'pool_only', label: '仅加入候选池' }
  ]

  function openFromLegacy(
    sourceStep: AdoptSourceStep,
    item: AdoptLegacyPayload,
    targetSlot?: IncubatorSlotKey
  ) {
    candidateId.value = null
    candidateFinalScore.value = null
    payload.value = toPlainForIpc({
      sourceStep,
      title: item.title,
      summary: item.summary,
      dimension: item.dimension ?? null,
      highlights: item.highlights ?? null,
      audience: item.audience ?? null
    })
    slotKey.value = targetSlot ?? (sourceStep === 'variants' ? 'core_conflict' : 'opening')
    mode.value = 'append_slot'
    adoptError.value = ''
    modalOpen.value = true
  }

  function openFromCandidate(
    id: number,
    item: { title: string; summary: string; sourceStep: AdoptSourceStep },
    defaultSlot: IncubatorSlotKey = 'opening',
    finalScore?: number | null
  ) {
    candidateId.value = id
    candidateFinalScore.value = finalScore ?? null
    payload.value = {
      sourceStep: item.sourceStep,
      title: item.title,
      summary: item.summary
    }
    slotKey.value = defaultSlot
    mode.value = 'append_slot'
    adoptError.value = ''
    modalOpen.value = true
  }

  function close() {
    modalOpen.value = false
    payload.value = null
    candidateId.value = null
    candidateFinalScore.value = null
  }

  async function confirm(): Promise<boolean> {
    if (adopting.value) return false
    adopting.value = true
    adoptError.value = ''
    try {
      let res: { success: boolean; error?: string }
      const sk = unref(slotKey)
      const m = unref(mode)
      if (candidateId.value != null) {
        res = await window.anovel.invoke(
          'incubator:adoptToSlot',
          toPlainForIpc({
            workId,
            candidateId: unref(candidateId)!,
            slotKey: sk,
            mode: m
          })
        ) as { success: boolean; error?: string }
      } else if (payload.value) {
        res = await window.anovel.invoke(
          'incubator:adoptLegacyToSlot',
          workId,
          toPlainForIpc(unref(payload)),
          sk,
          m
        ) as { success: boolean; error?: string }
      } else {
        return false
      }

      if (!res.success) {
        adoptError.value = res.error || '采纳失败'
        return false
      }

      try {
        await onSuccess()
      } catch (refreshErr) {
        const message = String(refreshErr)
        adoptError.value = `采纳成功，但刷新失败：${message}`
        await reportRendererError('incubator', `采纳后刷新失败: ${message}`, { workId })
        return false
      }

      close()
      return true
    } catch (e) {
      const message = String(e)
      adoptError.value = message
      await reportRendererError('incubator', `采纳失败: ${message}`, { workId })
      return false
    } finally {
      adopting.value = false
    }
  }

  return {
    modalOpen,
    adopting,
    adoptError,
    payload,
    candidateFinalScore,
    slotKey,
    mode,
    adoptModeOptions,
    openFromLegacy,
    openFromCandidate,
    close,
    confirm
  }
}
