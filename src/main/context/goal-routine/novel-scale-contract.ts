import { coreSettingDAO } from '../../db'
import { loadWritingPlan, type WritingPlan } from '../writing-plan'

export function novelScaleFingerprint(plan: WritingPlan): string {
  return `${plan.targetTotalWords}:${plan.targetChapters}:${plan.wordsPerChapter}`
}

export function formatNovelScaleContract(workId: number): string {
  const plan = loadWritingPlan(workId)
  return [
    '【全书规模硬合同】',
    `- 目标总字数：${plan.targetTotalWords} 字`,
    `- 目标章节数：${plan.targetChapters} 章`,
    `- 目标每章字数：${plan.wordsPerChapter} 字`,
    `- 所有全书阶段、爽点、冲突升级和终局规划必须覆盖第1章至第${plan.targetChapters}章。`,
    `- 禁止在第${plan.targetChapters}章之前写“大结局”“终章”“全书完结”。`,
    `- 最终清算必须明确标注“第${plan.targetChapters}章”，不得自行缩短篇幅。`
  ].join('\n')
}

export function validatePleasureEngineScale(workId: number, content?: string): {
  valid: boolean
  reason: string
} {
  const plan = loadWritingPlan(workId)
  const text = content ?? coreSettingDAO.getByType(workId, 'pleasure_engine')?.content ?? ''
  if (!text.trim()) return { valid: false, reason: '缺少爽点机制' }
  const finalChapterPattern = new RegExp(`第\\s*${plan.targetChapters}\\s*章`)
  if (!finalChapterPattern.test(text)) {
    return {
      valid: false,
      reason: `爽点机制没有覆盖目标末章第${plan.targetChapters}章`
    }
  }
  const prematureEnding = [...text.matchAll(/第\s*(\d+)\s*章[^\n]{0,40}(?:大结局|终章|全书完结)/g)]
    .map(match => Number(match[1]))
    .find(chapter => chapter < plan.targetChapters)
  if (prematureEnding != null) {
    return {
      valid: false,
      reason: `爽点机制在第${prematureEnding}章提前安排全书结局，目标末章是第${plan.targetChapters}章`
    }
  }
  return { valid: true, reason: '' }
}
