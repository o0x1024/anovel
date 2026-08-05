import { coreSettingDAO } from '../../db'
import { modelService } from '../../model'
import { buildWorkContext } from '../work-context'
import { isNoGoldenFingerDesign, validateGoldenFinger } from '../golden-finger-validation'
import {
  extractGoldenFingerFromAiContent,
  goldenFingerValidationIssues
} from '../../../shared/golden-finger-types'
import { formatNovelScaleContract, validatePleasureEngineScale } from './novel-scale-contract'
import { NovelPipelineError } from './novel-outline-pipeline'
import { shouldGenerateNovelGoldenFinger } from './novel-golden-finger-policy'
import { assertNovelGoalNotAborted as assertNotAborted } from './novel-runtime-utils'
import { NOVEL_SETTING_TYPES } from './novel-preparation'
import { NOVEL_SETTING_PROMPTS } from './novel-setting-prompts'
import { withGoalLoopModelOptions } from './story-goal-model'

const MAX_SETTING_GENERATION_ROUNDS = 4

export async function materializeNovelSettings(
  workId: number,
  goal: string,
  goldenFingerRequired: boolean,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  assertNotAborted(signal)
  const existing = coreSettingDAO.listByWork(workId)
  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true }).text.slice(0, 4000)
  const requireGoldenFinger = shouldGenerateNovelGoldenFinger({
    userRequired: goldenFingerRequired,
    goal,
    mainline
  })
  const targetTypes = requireGoldenFinger
    ? [...NOVEL_SETTING_TYPES]
    : NOVEL_SETTING_TYPES.filter(type => type !== 'golden_finger')
  const missing = targetTypes.filter(type => !existing.some(row => row.type === type && row.content?.trim()))
  if (!validatePleasureEngineScale(workId).valid && !missing.includes('pleasure_engine')) {
    missing.push('pleasure_engine')
  }
  const goldenFingerRow = coreSettingDAO.getByType(workId, 'golden_finger')
  const goldenFingerInvalid = requireGoldenFinger && (
    !goldenFingerRow?.content?.trim()
    || isNoGoldenFingerDesign(goldenFingerRow.content)
    || !validateGoldenFinger(workId).valid
  )
  if (goldenFingerInvalid && !missing.includes('golden_finger')) missing.push('golden_finger')
  if (!requireGoldenFinger) onProgress?.('检测为无特殊机制题材，跳过「金手指系统」生成')
  if (missing.length === 0) {
    onProgress?.('核心设定已存在，跳过')
    return 0
  }

  let count = 0
  for (const type of missing) {
    for (let attempt = 1; attempt <= MAX_SETTING_GENERATION_ROUNDS; attempt++) {
      assertNotAborted(signal)
      onProgress?.(`正在生成核心设定「${type}」(${count + 1}/${missing.length}，第 ${attempt} 轮)`)
      const existingText = targetTypes
        .filter(otherType => otherType !== type)
        .map(otherType => coreSettingDAO.getByType(workId, otherType)?.content?.trim()
          ? `## ${otherType}\n${coreSettingDAO.getByType(workId, otherType)?.content?.trim()}`
          : '')
        .filter(Boolean)
        .join('\n\n')
      const response = await modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: `settings_${type}`,
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          systemPrompt: [
            NOVEL_SETTING_PROMPTS[type],
            type === 'golden_finger' && goldenFingerRequired
              ? '用户已在目标循环明确选择「金手指」。必须设计真实的特殊机制，不得输出“无金手指”“无特殊机制”或用普通技能、身份优势替代。'
              : '',
            type === 'pleasure_engine'
              ? '爽点机制必须按全书阶段规划，并明确写出目标末章的终极清算；不得自行虚构更短的卷数或提前完结。'
              : ''
          ].filter(Boolean).join('\n\n'),
          prompt: [
            formatNovelScaleContract(workId),
            goal.trim() ? `【用户创作目标】\n${goal.trim()}` : '',
            `【长篇主线】\n${mainline}`,
            existingText ? `【已生成设定】\n${existingText}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      )
      if (!response.success || !response.content?.trim()) {
        onProgress?.(`核心设定「${type}」第 ${attempt} 轮未返回有效内容${attempt < MAX_SETTING_GENERATION_ROUNDS ? '，正在重试' : ''}`)
        continue
      }
      if (type === 'pleasure_engine') {
        const scaleGate = validatePleasureEngineScale(workId, response.content.trim())
        if (!scaleGate.valid) {
          onProgress?.(`爽点机制规模门禁未通过：${scaleGate.reason}${attempt < MAX_SETTING_GENERATION_ROUNDS ? '，正在重新生成' : ''}`)
          continue
        }
      }
      if (type === 'golden_finger' && requireGoldenFinger) {
        const extracted = extractGoldenFingerFromAiContent(response.content.trim())
        const issues = extracted ? goldenFingerValidationIssues(extracted.structured) : ['无法解析结构化金手指']
        if (issues.length > 0) {
          onProgress?.(`金手指结构化门禁未通过：${issues.join('、')}${attempt < MAX_SETTING_GENERATION_ROUNDS ? '，正在重新生成' : ''}`)
          continue
        }
      }
      coreSettingDAO.upsert(workId, type, response.content.trim())
      count++
      onProgress?.(`已回填核心设定「${type}」`)
      break
    }
  }

  const unresolved = targetTypes.filter(type => !coreSettingDAO.getByType(workId, type)?.content?.trim())
  if (unresolved.length > 0) throw new Error(`核心设定生成不完整：${unresolved.join('、')}`)
  const pleasureScaleGate = validatePleasureEngineScale(workId)
  if (!pleasureScaleGate.valid) {
    throw new NovelPipelineError('CONTRACT_INVALID', `爽点机制规模门禁未通过：${pleasureScaleGate.reason}`)
  }
  if (requireGoldenFinger) {
    const generatedRow = coreSettingDAO.getByType(workId, 'golden_finger')
    const goldenFinger = validateGoldenFinger(workId)
    if (!generatedRow?.content?.trim() || isNoGoldenFingerDesign(generatedRow.content) || !goldenFinger.valid) {
      throw new NovelPipelineError('PREREQUISITE_MISSING', `金手指设定不完整：${goldenFinger.issues.join('、')}`)
    }
  }
  return count
}
