import { modelService } from '../../model'
import { coreSettingDAO } from '../../db'
import {
  buildSettingsQualityInput,
  getReviseAllTargets,
  recordQualityCheck
} from '../settings-quality'
import { OVERALL_CHECK_SYSTEM_PROMPT } from '../settings-quality-check-prompts'
import { assertNovelGoalNotAborted } from './novel-runtime-utils'
import { withGoalLoopModelOptions } from './story-goal-model'
import { NOVEL_SETTING_TYPES } from './novel-preparation'
import { NOVEL_SETTING_PROMPTS } from './novel-setting-prompts'
import {
  buildNovelSettingsRepairTasks,
  formatNovelSettingsRepairTask
} from './novel-settings-repair-plan'

export async function runNovelOverallSelfCheck(
  workId: number,
  signal?: AbortSignal
): Promise<string> {
  assertNovelGoalNotAborted(signal)
  const prompt = buildSettingsQualityInput(workId)
  if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) {
    return '设定内容为空，跳过自检'
  }
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'settings_overall_check',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: OVERALL_CHECK_SYSTEM_PROMPT,
      prompt,
      // 整体自检是单次长模型调用，必须有明确边界，不能让工作流无限等待。
      timeoutMs: 120_000
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) {
    // 不把模型空响应伪装成“无 blocking 但分数不足”。必须保留提供方的
    // finishReason/reasoning 证据，让工作流按预算或协议故障停在检查点。
    throw new Error(res.error || 'SETTINGS_QUALITY_PROTOCOL: 整体自检未返回正文')
  }
  recordQualityCheck(workId, {
    overall: { report: res.content, checkedAt: new Date().toISOString() }
  })
  return res.content.trim()
}

export async function repairNovelSettingsFromOverallCheck(
  workId: number,
  report: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  const targets = getReviseAllTargets(workId, report)
  const tasks = buildNovelSettingsRepairTasks(targets)
  if (tasks.length === 0) return 0

  const mainline = coreSettingDAO.getByType(workId, 'main_plotline')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || ''
  let revised = 0
  for (const task of tasks) {
    assertNovelGoalNotAborted(signal)
    const type = task.settingType
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
    const crossContext = task.requiresCrossContext
      ? NOVEL_SETTING_TYPES
          .filter(other => other !== type && other !== 'main_plotline')
          .map(other => {
            const content = coreSettingDAO.getByType(workId, other)?.content?.trim()
            return content ? `## ${other}\n${content}` : ''
          })
          .filter(Boolean)
          .join('\n\n')
      : ''
    const repairTask = formatNovelSettingsRepairTask(task)
    onProgress?.(`正在根据整体自检修订「${type}」`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: `settings_${type}_revise`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        forceThinkingDisabled: true,
        systemPrompt: [
          NOVEL_SETTING_PROMPTS[type],
          '你是长篇设定落稿执行器，深度分析已经由上游整体自检完成。',
          '只执行任务单中的 blocking 修复；保留所有未被任务单点名且已自洽的内容。',
          '不要重新评估、扩写或顺带优化 advisory；输出完整修订后的 Markdown，不要解释。'
        ].join('\n\n'),
        prompt: [
          `【长篇主线】\n${mainline}`,
          `【当前 ${type}】\n${current || '（空）'}`,
          crossContext ? `【跨设定修复所需的已确定设定】\n${crossContext}` : '',
          `【本次 blocking 修复任务单】\n${repairTask}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      throw new Error(response.error || `整体自检修订 ${type} 失败`)
    }
    if (response.content.trim() !== current) {
      coreSettingDAO.upsert(workId, type, response.content.trim())
      revised++
    }
  }
  return revised
}
