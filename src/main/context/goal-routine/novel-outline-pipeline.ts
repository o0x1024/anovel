import {
  goalRoutineDAO,
  coreSettingDAO,
  novelOutlineDAO,
  resourceLedgerDAO,
  volumeChapterDAO,
  type ChapterResourceBudgetInput,
  type NovelOutlineBatchItem
} from '../../db'
import { modelService } from '../../model'
import { buildWorkContext } from '../work-context'
import { extractJsonText } from '../parse-json-extract'
import { formatResourceConstraintsForPrompt, normalizeChapterResourceBudgets } from '../resource-ledger'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { withGoalLoopModelOptions } from './story-goal-model'
import { normalizeEmotionContract, validateEmotionContract } from '../../../shared/emotion-contract'
import { EMOTION_CONTRACT_JSON_SHAPE } from './emotion-engine'
import type { GoalCheckResult } from './story-goal-checker'
import { goldenOutlineContract } from '../../../shared/golden-opening'
import { retentionEvaluationRules, retentionPlanningRules } from './reader-retention'
import {
  formatNovelScaleContract,
  novelScaleFingerprint,
  validatePleasureEngineScale
} from './novel-scale-contract'

const OUTLINE_BATCH_SIZE = 6
const MAX_GATE_REPAIR_ROUNDS = 4
const TARGET_CHAPTERS_PER_VOLUME = 42
const MAX_CHAPTERS_PER_VOLUME = 50

export interface NovelVolumeContract {
  name: string
  description: string
  startChapter: number
  endChapter: number
  objective: string
  midpoint: string
  climax: string
  irreversibleCost: string
  nextDebt: string
}

export interface NovelOutlineProgressState {
  version: 2
  targetChapters: number
  volumePlan: NovelVolumeContract[]
}

export interface NovelVolumeRange {
  startChapter: number
  endChapter: number
}

export interface NovelGoalPersistentState {
  lastCheck?: GoalCheckResult
  novelOutline?: NovelOutlineProgressState
  volumePlanChecked?: boolean
  volumeQualityReport?: string
  checkedChapterVolumes?: string[]
  pendingChapterVolumeGate?: string
  pleasureVolumeFingerprint?: string
  repairPlan?: unknown
  overallRepairRounds?: number
  repairStall?: { signature: string; count: number }
  titleHookCandidates?: Array<{ title: string; hook: string; summary?: string }>
  titleHookPreferredIndex?: number
  failure?: {
    phase: string
    signature: string
    count: number
    message: string
  }
}

export interface NovelOutlineBatchResult {
  created: number
  reused: number
  remaining: number
  complete: boolean
  range?: { start: number; end: number }
  volumeGate?: { volume: string; score: number; rounds: number }
}

export class NovelPipelineError extends Error {
  constructor(
    public readonly code: 'OUTPUT_INVALID' | 'CONTRACT_INVALID' | 'PREREQUISITE_MISSING',
    message: string
  ) {
    super(message)
    this.name = 'NovelPipelineError'
  }
}

export function readNovelGoalState(workId: number): NovelGoalPersistentState {
  const raw = goalRoutineDAO.getByWork(workId)?.state_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as NovelGoalPersistentState : {}
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', '目标循环状态损坏：state_json 不是合法 JSON')
  }
}

export function updateNovelGoalState(workId: number, patch: Partial<NovelGoalPersistentState>): void {
  const current = readNovelGoalState(workId)
  goalRoutineDAO.update(workId, { state_json: JSON.stringify({ ...current, ...patch }) })
}

function parseObject(content: string, label: string): Record<string, unknown> {
  const json = extractJsonText(content.trim()) ?? content.trim()
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const tail = content.trim().slice(-160).replace(/\s+/g, ' ')
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `${label}解析失败：${error instanceof Error ? error.message : String(error)}；回复末尾：${tail}`
    )
  }
}

function textField(row: Record<string, unknown>, key: string, label: string): string {
  const value = String(row[key] ?? '').trim()
  if (!value) throw new NovelPipelineError('CONTRACT_INVALID', `${label}缺少字段 ${key}`)
  return value
}

function intField(row: Record<string, unknown>, key: string, label: string): number {
  const value = Number(row[key])
  if (!Number.isInteger(value) || value <= 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `${label}.${key} 必须是正整数`)
  }
  return value
}

function expectedVolumeCount(targetChapters: number): number {
  return Math.max(
    1,
    Math.round(targetChapters / TARGET_CHAPTERS_PER_VOLUME),
    Math.ceil(targetChapters / MAX_CHAPTERS_PER_VOLUME)
  )
}

/**
 * 章节边界由程序确定，模型只负责设计每卷剧情。
 * 余数从前往后每卷多分配一章，使任意两卷的长度差不超过 1。
 */
export function planNovelVolumeRanges(targetChapters: number): NovelVolumeRange[] {
  if (!Number.isInteger(targetChapters) || targetChapters <= 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', '目标章节数必须是正整数')
  }
  const volumeCount = expectedVolumeCount(targetChapters)
  const baseSize = Math.floor(targetChapters / volumeCount)
  const remainder = targetChapters % volumeCount
  let startChapter = 1
  return Array.from({ length: volumeCount }, (_, index) => {
    const size = baseSize + (index < remainder ? 1 : 0)
    const range = { startChapter, endChapter: startChapter + size - 1 }
    startChapter = range.endChapter + 1
    return range
  })
}

function validateVolumePlan(raw: unknown, targetChapters: number): NovelVolumeContract[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', '分卷合同必须包含非空 volumes 数组')
  }
  const plan = raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${index + 1} 个分卷合同不是对象`)
    }
    const row = item as Record<string, unknown>
    const label = `第 ${index + 1} 个分卷合同`
    return {
      name: textField(row, 'name', label),
      description: textField(row, 'description', label),
      startChapter: intField(row, 'startChapter', label),
      endChapter: intField(row, 'endChapter', label),
      objective: textField(row, 'objective', label),
      midpoint: textField(row, 'midpoint', label),
      climax: textField(row, 'climax', label),
      irreversibleCost: textField(row, 'irreversibleCost', label),
      nextDebt: textField(row, 'nextDebt', label)
    }
  })
  const expectedRanges = planNovelVolumeRanges(targetChapters)
  const expectedVolumes = expectedRanges.length
  if (plan.length !== expectedVolumes) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷合同必须包含 ${expectedVolumes} 卷，实际 ${plan.length} 卷`)
  }

  const names = new Set<string>()
  for (let index = 0; index < plan.length; index++) {
    const volume = plan[index]
    const expected = expectedRanges[index]
    if (names.has(volume.name)) throw new NovelPipelineError('CONTRACT_INVALID', `分卷名称重复：${volume.name}`)
    names.add(volume.name)
    if (volume.startChapter !== expected.startChapter || volume.endChapter !== expected.endChapter) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `第 ${index + 1} 个分卷章节范围必须是 ${expected.startChapter}-${expected.endChapter}，实际为 ${volume.startChapter}-${volume.endChapter}`
      )
    }
  }
  return plan
}

async function generateVolumePlan(
  workId: number,
  goal: string,
  targetChapters: number,
  signal?: AbortSignal
): Promise<NovelVolumeContract[]> {
  const ctx = buildWorkContext(workId, { includeVolumes: false, includeCoreSettings: true })
  const plannedRanges = planNovelVolumeRanges(targetChapters)
  const suggestedVolumes = plannedRanges.length
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_plan',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 5000,
      systemPrompt: [
        '你是长篇小说总架构师。只输出合法 JSON 对象，不要 markdown、前言或解释。',
        `为 ${targetChapters} 章小说设计恰好 ${suggestedVolumes} 个连续分卷，不得减少或增加卷数。`,
        '每卷必须形成阶段闭环，同时留下进入下一卷的新债务。',
        'startChapter 和 endChapter 必须逐项照抄用户消息中的预设范围，不得重新分配、合并或拆分。',
        `格式：{"volumes":[{"name":"第一卷 名称","description":"本卷核心冲突与升级路径","startChapter":${plannedRanges[0].startChapter},"endChapter":${plannedRanges[0].endChapter},"objective":"主角阶段目标","midpoint":"中点反转","climax":"卷高潮与兑现","irreversibleCost":"永久代价","nextDebt":"留给下一卷的未偿债务"}]}`
      ].join('\n'),
      prompt: [
        `【用户目标】\n${goal.trim() || '自动策划一部长篇小说'}`,
        `【目标章节数】${targetChapters}`,
        `【不可修改的分卷章节范围】\n${JSON.stringify(plannedRanges, null, 2)}`,
        `【核心设定】\n${ctx.text.slice(0, 14000)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`分卷合同生成失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, '分卷合同')
  return validateVolumePlan(parsed.volumes, targetChapters)
}

async function diagnoseVolumePlan(
  workId: number,
  goal: string,
  plan: NovelVolumeContract[],
  signal?: AbortSignal
): Promise<{ passed: boolean; report: string }> {
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是长篇小说分卷架构门禁。只输出合法 JSON，不要 markdown 或解释。',
        '逐卷检查阶段目标、冲突升级、中点转折、卷高潮、不可逆代价和跨卷债务。',
        '重点检查上一卷 nextDebt 是否因果驱动下一卷 objective，禁止冲突降级、高潮重复、成长停滞、代价重置和终卷未闭环。',
        '格式：{"passed":true,"score":90,"issues":[{"volumes":"第一卷→第二卷","problem":"问题","requiredFix":"必须如何修复"}]}'
      ].join('\n'),
      prompt: `【创作目标】\n${goal.trim() || '完成一部长篇小说'}\n\n【全书分卷合同】\n${JSON.stringify(plan, null, 2)}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '分卷质量门禁未返回结果')
  const parsed = parseObject(response.content, '分卷质量门禁')
  if (typeof parsed.passed !== 'boolean' || !Array.isArray(parsed.issues)) {
    throw new NovelPipelineError('OUTPUT_INVALID', '分卷质量门禁缺少 passed 或 issues')
  }
  return { passed: parsed.passed, report: JSON.stringify(parsed) }
}

async function reviseVolumePlan(
  workId: number,
  goal: string,
  targetChapters: number,
  plan: NovelVolumeContract[],
  report: string,
  signal?: AbortSignal
): Promise<NovelVolumeContract[]> {
  const plannedRanges = planNovelVolumeRanges(targetChapters)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_revise',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 6000,
      systemPrompt: [
        '你是长篇小说总架构修订师。只输出合法 JSON，不要 markdown 或解释。',
        `必须保留恰好 ${plannedRanges.length} 卷。`,
        'startChapter 和 endChapter 必须逐项照抄用户消息中的预设范围，不得重新分配、合并或拆分。',
        '逐项修复门禁报告；上一卷 nextDebt 必须直接驱动下一卷 objective；冲突、高潮、成长和不可逆代价必须逐卷升级。',
        '输出格式与输入相同：{"volumes":[...]}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
        `【不可修改的分卷章节范围】\n${JSON.stringify(plannedRanges, null, 2)}`,
        `【当前分卷合同】\n${JSON.stringify({ volumes: plan }, null, 2)}`,
        `【门禁报告】\n${report}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '分卷合同修订失败')
  const parsed = parseObject(response.content, '分卷合同修订')
  return validateVolumePlan(parsed.volumes, targetChapters)
}

function materializeVolumePlan(workId: number, plan: NovelVolumeContract[]): void {
  const existing = volumeChapterDAO.listVolumes(workId)
  const canReconcileByPosition = volumeChapterDAO.listChaptersByWork(workId).length === 0
  for (let index = 0; index < plan.length; index++) {
    const contract = plan[index]
    const description = [
      contract.description,
      `【阶段目标】${contract.objective}`,
      `【中点转折】${contract.midpoint}`,
      `【卷高潮】${contract.climax}`,
      `【不可逆代价】${contract.irreversibleCost}`,
      `【跨卷债务】${contract.nextDebt}`,
      `【章节范围】${contract.startChapter}-${contract.endChapter}`
    ].join('\n')
    // 尚未生成章节时复用原有空卷，避免规划版本升级后残留旧卷或重复建卷。
    // 已有章节时仍按名称匹配，绝不静默搬迁或删除用户内容。
    const row = canReconcileByPosition
      ? existing[index]
      : existing.find(item => item.name === contract.name)
    if (row) {
      volumeChapterDAO.updateVolume(row.id, {
        name: contract.name,
        description,
        sort: index + 1,
        plannedStartChapter: contract.startChapter,
        plannedEndChapter: contract.endChapter
      })
    } else {
      volumeChapterDAO.createVolume(workId, contract.name, description, index + 1, {
        startChapter: contract.startChapter,
        endChapter: contract.endChapter
      })
    }
  }
  if (canReconcileByPosition) {
    for (const obsolete of existing.slice(plan.length)) {
      volumeChapterDAO.deleteVolume(obsolete.id)
    }
  }
}

function pleasureVolumeFingerprint(workId: number, plan: NovelVolumeContract[]): string {
  return [
    novelScaleFingerprint(loadWritingPlan(workId)),
    ...plan.map(volume => `${volume.name}:${volume.startChapter}-${volume.endChapter}`)
  ].join('|')
}

async function ensurePleasureEngineMatchesVolumePlan(
  workId: number,
  goal: string,
  plan: NovelVolumeContract[],
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  const fingerprint = pleasureVolumeFingerprint(workId, plan)
  const state = readNovelGoalState(workId)
  const current = coreSettingDAO.getByType(workId, 'pleasure_engine')?.content?.trim() ?? ''
  const scaleGate = validatePleasureEngineScale(workId, current)
  const coversVolumes = plan.every(volume => current.includes(volume.name))
  if (state.pleasureVolumeFingerprint === fingerprint && scaleGate.valid && coversVolumes) return

  for (let round = 1; round <= MAX_GATE_REPAIR_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在执行爽点机制与分卷大纲映射门禁（第 ${round} 轮）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_pleasure_volume_alignment',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          '你是长篇小说爽点架构师。根据已经冻结的分卷合同，重写完整爽点机制 Markdown，不要解释。',
          '必须保留合理的爽点类型与对抗设计，但所有阶段锚点必须逐卷映射到实际卷名和章节范围。',
          '每一卷至少给出一个小高潮或大高潮锚点；最终清算只能位于目标末章。',
          '输出结构：## 主要爽点类型 / ## 频率设计 / ## 分卷爽点锚点 / ## 终极清算。'
        ].join('\n'),
        prompt: [
          formatNovelScaleContract(workId),
          `【用户创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
          `【冻结分卷合同】\n${JSON.stringify(plan, null, 2)}`,
          `【当前爽点机制】\n${current || '尚未生成'}`
        ].join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      onProgress?.(`爽点映射第 ${round} 轮未返回有效内容，正在继续重试`)
      continue
    }
    const revised = response.content.trim()
    const revisedScaleGate = validatePleasureEngineScale(workId, revised)
    const missingVolumes = plan.filter(volume => !revised.includes(volume.name)).map(volume => volume.name)
    if (!revisedScaleGate.valid || missingVolumes.length > 0) {
      onProgress?.(
        `爽点映射门禁未通过：${revisedScaleGate.reason || `缺少分卷 ${missingVolumes.join('、')}`}，正在继续修订`
      )
      continue
    }
    coreSettingDAO.upsert(workId, 'pleasure_engine', revised)
    updateNovelGoalState(workId, { pleasureVolumeFingerprint: fingerprint })
    onProgress?.(`爽点机制已覆盖 ${plan.length} 卷并对齐目标末章`)
    return
  }
  throw new NovelPipelineError(
    'CONTRACT_INVALID',
    `爽点机制与分卷大纲连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未能对齐，请调整设定或模型后重试`
  )
}

async function runVolumeChapterGate(
  workId: number,
  goal: string,
  contract: NovelVolumeContract,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ score: number; rounds: number }> {
  const volume = volumeChapterDAO.listVolumes(workId).find(item => item.name === contract.name)
  if (!volume) throw new NovelPipelineError('PREREQUISITE_MISSING', `分卷「${contract.name}」尚未落库`)
  let rounds = 0
  let lastScore = -1
  while (rounds < MAX_GATE_REPAIR_ROUNDS) {
    rounds++
    const chapters = volumeChapterDAO.listChapters(volume.id)
    if (chapters.length !== contract.endChapter - contract.startChapter + 1) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${contract.name}」章节情节尚未完整，不能执行整卷门禁`)
    }
    onProgress?.(`正在诊断「${contract.name}」章节情节第 ${rounds} 轮`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_volume_chapter_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        maxTokens: 12000,
        systemPrompt: [
          '你是长篇小说整卷章节情节门禁。只输出合法 JSON，不要 markdown 或解释。',
          '逐项检查本卷全部章节是否兑现阶段目标、中点转折、卷高潮、不可逆代价和跨卷债务。',
          '同时检查因果链、冲突升级、角色成长、伏笔回收、章节功能重复、节奏断层和卷末进入下一卷的接口。',
          '修复补丁必须继续满足该章既有资源预算，不得改变数值资源的起止合同。',
          '只有不存在阻断问题时 passed 才能为 true。',
          '需要修复时 patches 仅列出必须修改的章节；每项必须输出完整替换值。',
          `格式：{"passed":false,"score":75,"issues":[{"chapterNumber":3,"problem":"问题","requiredFix":"修复要求"}],"patches":[{"chapterNumber":3,"title":"完整标题","outline":"完整章节情节","beat_role":"A/B/C","foreshadow_target":"伏笔或空字符串","next_hook":"完整钩子","characters":["角色"],"dramatic_contract":{"scene_promise":"","protagonist_want":"","obstacle":"","stakes":"","info_gap":"","pressure_escalation":"","turn":"","irreversible_change":"","payoff_or_debt":"","next_question":""},"tension_plan":{"level":7,"payoff_type":"debt/partial/major/aftertaste"},"emotion_contract":${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)}}]}`
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
          `【本卷合同】\n${JSON.stringify(contract, null, 2)}`,
          `【本卷全部章节情节】\n${JSON.stringify(chapters.map((chapter, index) => ({
            chapterNumber: contract.startChapter + index,
            title: chapter.title,
            outline: chapter.outline,
            beat_role: chapter.beat_role,
            foreshadow_target: chapter.foreshadow_target,
            next_hook: chapter.next_hook,
            characters: chapter.characters,
            outline_diagnosis: chapter.outline_diagnosis,
            resource_budgets: resourceLedgerDAO.listBudgetsByChapter(workId, chapter.id)
          })), null, 2)}`
        ].join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) throw new Error(response.error || '本卷章节情节门禁未返回结果')
    const parsed = parseObject(response.content, `分卷「${contract.name}」章节情节门禁`)
    if (typeof parsed.passed !== 'boolean' || !Array.isArray(parsed.issues) || !Array.isArray(parsed.patches)) {
      throw new NovelPipelineError('OUTPUT_INVALID', '本卷章节情节门禁缺少 passed、issues 或 patches')
    }
    lastScore = Number(parsed.score)
    if (parsed.passed && parsed.issues.length === 0) return { score: Number.isFinite(lastScore) ? lastScore : 100, rounds }
    if (parsed.patches.length === 0) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${contract.name}」门禁未通过且没有返回修复补丁`)
    }
    onProgress?.(`「${contract.name}」门禁未通过，正在修复 ${parsed.patches.length} 个章节情节`)
    for (const value of parsed.patches) {
      if (!value || typeof value !== 'object') throw new NovelPipelineError('OUTPUT_INVALID', '章节修复补丁不是对象')
      const patch = value as Record<string, unknown>
      const chapterNumber = intField(patch, 'chapterNumber', '章节修复补丁')
      const index = chapterNumber - contract.startChapter
      const chapter = chapters[index]
      if (!chapter || chapterNumber > contract.endChapter) {
        throw new NovelPipelineError('CONTRACT_INVALID', `章节修复补丁越出本卷范围：第 ${chapterNumber} 章`)
      }
      const beatRole = textField(patch, 'beat_role', `第 ${chapterNumber} 章补丁`)
      if (!['A', 'B', 'C'].includes(beatRole)) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章补丁 beat_role 非法`)
      const dramaticContract = validateDramaticContract(patch.dramatic_contract, chapterNumber)
      const emotionContract = normalizeEmotionContract(patch.emotion_contract)
      if (!emotionContract || validateEmotionContract(emotionContract).length > 0) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章补丁缺少完整 emotion_contract`)
      }
      if (!patch.tension_plan || typeof patch.tension_plan !== 'object' || Array.isArray(patch.tension_plan)) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章补丁缺少 tension_plan`)
      }
      const tensionPlan = patch.tension_plan as Record<string, unknown>
      const tensionLevel = intField(tensionPlan, 'level', `第 ${chapterNumber} 章 tension_plan`)
      if (tensionLevel > 10) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 tension_plan.level 必须在 1-10`)
      const payoffType = textField(tensionPlan, 'payoff_type', `第 ${chapterNumber} 章 tension_plan`)
      if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 tension_plan.payoff_type 非法`)
      }
      volumeChapterDAO.updateChapterWithVersion(chapter.id, {
        title: textField(patch, 'title', `第 ${chapterNumber} 章补丁`),
        outline: textField(patch, 'outline', `第 ${chapterNumber} 章补丁`),
        beat_role: beatRole,
        foreshadow_target: String(patch.foreshadow_target ?? '').trim() || null,
        next_hook: textField(patch, 'next_hook', `第 ${chapterNumber} 章补丁`),
        characters: JSON.stringify(normalizeCharacters(patch.characters, chapterNumber)),
        emotion_contract_json: JSON.stringify(emotionContract),
        outline_diagnosis: JSON.stringify({
          arc_phase: JSON.parse(chapter.outline_diagnosis || '{}').arc_phase ?? '',
          dramatic_contract: dramaticContract,
          tension_plan: { level: tensionLevel, payoff_type: payoffType },
          emotion_contract: emotionContract
        })
      })
    }
  }
  throw new NovelPipelineError(
    'CONTRACT_INVALID',
    `分卷「${contract.name}」章节情节连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未通过门禁（最终 ${lastScore} 分）`
  )
}

function normalizeCharacters(value: unknown, chapterNumber: number): string[] {
  if (!Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 characters 必须是数组`)
  }
  const names = value.map(String).map(s => s.trim()).filter(Boolean)
  if (names.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章没有出场角色`)
  }
  return [...new Set(names)]
}

function validateDramaticContract(value: unknown, chapterNumber: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少 dramatic_contract`)
  }
  const contract = value as Record<string, unknown>
  for (const key of ['scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'turn', 'irreversible_change', 'next_question']) {
    textField(contract, key, `第 ${chapterNumber} 章 dramatic_contract`)
  }
  return contract
}

function budgetKey(budget: { owner?: string | null; resource: string }): string {
  return `${budget.owner?.trim() || '*'}::${budget.resource.trim()}`
}

function resourceBudgetExample(
  workId: number,
  previousBudgets: Map<string, ChapterResourceBudgetInput>
): ChapterResourceBudgetInput[] {
  return resourceLedgerDAO.listConstraints(workId)
    .filter(isNumericConstraint)
    .map(row => {
      const previous = previousBudgets.get(budgetKey(row))
      const startMin = previous?.end_min ?? row.initial_value ?? row.min_value ?? 0
      const startMax = previous?.end_max ?? row.initial_value ?? row.max_value ?? row.min_value ?? 0
      return {
        owner: row.owner ?? null,
        resource: row.resource,
        unit: row.unit ?? null,
        start_min: startMin,
        start_max: startMax,
        end_min: startMin,
        end_max: startMax,
        allowed_events: '填写本章允许发生的资源变化',
        forbidden_events: '填写本章禁止发生的资源变化',
        reason: previous ? '开章区间严格承接上一章章末区间' : '开章区间包含全书初始值'
      }
    })
}

function previousResourceBudgetContext(previousBudgets: Map<string, ChapterResourceBudgetInput>): string {
  if (previousBudgets.size === 0) return ''
  return [
    '【上一章资源预算 - 本批第一章必须严格承接】',
    ...Array.from(previousBudgets.entries()).map(([key, budget]) =>
      `- ${key}：上一章章末 ${budget.end_min}-${budget.end_max}${budget.unit || ''}；本批第一章 start_min/start_max 必须与该区间相交`)
  ].join('\n')
}

function isNumericConstraint(constraint: ReturnType<typeof resourceLedgerDAO.listConstraints>[number]): boolean {
  if (constraint.initial_value != null || constraint.min_value != null || constraint.max_value != null) return true
  if (!constraint.milestones_json) return false
  try {
    const milestones = JSON.parse(constraint.milestones_json) as Array<Record<string, unknown>>
    return milestones.some(item => Number.isFinite(Number(item.min)) || Number.isFinite(Number(item.max)))
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', `资源 ${constraint.resource} 的里程碑配置不是合法 JSON`)
  }
}

function rangesOverlap(aMin: number | null | undefined, aMax: number | null | undefined, bMin: number | null | undefined, bMax: number | null | undefined): boolean {
  if (aMin == null || aMax == null || bMin == null || bMax == null) return false
  return Math.max(aMin, bMin) <= Math.min(aMax, bMax)
}

function validateResourceBudgets(
  workId: number,
  previousChapterId: number | null,
  batches: Array<{ chapterNumber: number; budgets: ChapterResourceBudgetInput[] }>
): void {
  const constraints = resourceLedgerDAO.listConstraints(workId)
  if (constraints.length === 0) return
  const numericConstraints = constraints.filter(isNumericConstraint)
  const required = new Set(numericConstraints.map(row => budgetKey(row)))
  const previous = new Map<string, ChapterResourceBudgetInput>()
  if (previousChapterId) {
    for (const budget of resourceLedgerDAO.listBudgetsByChapter(workId, previousChapterId)) {
      previous.set(budgetKey(budget), budget)
    }
  }

  for (const batch of batches) {
    const current = new Map(batch.budgets.map(budget => [budgetKey(budget), budget]))
    for (const key of required) {
      const budget = current.get(key)
      if (!budget) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章缺少资源预算 ${key}`)
      }
      if (budget.start_min == null || budget.start_max == null || budget.end_min == null || budget.end_max == null) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源预算 ${key} 缺少完整起止区间`)
      }
      const prior = previous.get(key)
      if (prior?.end_min != null && prior.end_max != null) {
        // 开章资源是上一章章末状态的确定继承，不允许交给模型重新估算。
        budget.start_min = prior.end_min
        budget.start_max = prior.end_max
      }
      if (prior && !rangesOverlap(prior.end_min, prior.end_max, budget.start_min, budget.start_max)) {
        throw new NovelPipelineError(
          'CONTRACT_INVALID',
          `第 ${batch.chapterNumber} 章资源 ${key} 开章区间 ${budget.start_min}-${budget.start_max} 与上一章章末区间 ${prior.end_min}-${prior.end_max} 断裂`
        )
      }
      const constraint = numericConstraints.find(row => budgetKey(row) === key)
      if (!prior && batch.chapterNumber === 1 && constraint?.initial_value != null
        && (constraint.initial_value < budget.start_min! || constraint.initial_value > budget.start_max!)) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 1 章资源 ${key} 开章区间不包含初始值 ${constraint.initial_value}`)
      }
      if (constraint?.milestones_json) {
        try {
          const milestones = JSON.parse(constraint.milestones_json) as Array<Record<string, unknown>>
          for (const milestone of milestones.filter(item => Number(item.chapter) === batch.chapterNumber)) {
            const min = Number(milestone.min)
            const max = Number(milestone.max)
            if (Number.isFinite(min) && budget.end_max! < min) {
              throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源 ${key} 预算无法达到里程碑下限 ${min}`)
            }
            if (Number.isFinite(max) && budget.end_min! > max) {
              throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源 ${key} 预算超过里程碑上限 ${max}`)
            }
          }
        } catch (error) {
          if (error instanceof NovelPipelineError) throw error
          throw new NovelPipelineError('CONTRACT_INVALID', `资源 ${key} 里程碑配置不是合法 JSON`)
        }
      }
    }
    previous.clear()
    for (const [key, value] of current) previous.set(key, value)
  }
}

function validateChapterBatch(input: {
  parsed: Record<string, unknown>
  start: number
  end: number
  outlineMin: number
  workId: number
  previousChapterId: number | null
}): NovelOutlineBatchItem[] {
  if (Number(input.parsed.startChapter) !== input.start || Number(input.parsed.endChapter) !== input.end) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次范围不匹配，期望 ${input.start}-${input.end}`)
  }
  const raw = input.parsed.chapters
  if (!Array.isArray(raw) || raw.length !== input.end - input.start + 1) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次数量不匹配，期望 ${input.end - input.start + 1} 章，实际 ${Array.isArray(raw) ? raw.length : 0} 章`)
  }

  const budgetRows: Array<{ chapterNumber: number; budgets: ChapterResourceBudgetInput[] }> = []
  const items = raw.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new NovelPipelineError('CONTRACT_INVALID', `章节批次第 ${index + 1} 项不是对象`)
    }
    const row = value as Record<string, unknown>
    const chapterNumber = intField(row, 'chapterNumber', `章节批次第 ${index + 1} 项`)
    const expected = input.start + index
    if (chapterNumber !== expected) {
      throw new NovelPipelineError('CONTRACT_INVALID', `章节编号不连续：期望第 ${expected} 章，实际第 ${chapterNumber} 章`)
    }
    const outline = textField(row, 'outline', `第 ${chapterNumber} 章`)
    if (outline.replace(/\s/g, '').length < Math.max(120, Math.floor(input.outlineMin * 0.7))) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章大纲过短，无法作为正文执行蓝图`)
    }
    const payoffRole = textField(row, 'payoff_role', `第 ${chapterNumber} 章`)
    if (!['A', 'B', 'C'].includes(payoffRole)) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 payoff_role 必须是 A/B/C`)
    }
    const tensionLevel = intField(row, 'tension_level', `第 ${chapterNumber} 章`)
    if (tensionLevel > 10) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 tension_level 必须在 1-10`)
    const payoffType = textField(row, 'payoff_type', `第 ${chapterNumber} 章`)
    if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 payoff_type 非法`)
    }
    const contract = validateDramaticContract(row.dramatic_contract, chapterNumber)
    const emotionContract = normalizeEmotionContract(row.emotion_contract)
    if (!emotionContract || validateEmotionContract(emotionContract).length > 0) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少完整 emotion_contract`)
    }
    const budgets = normalizeChapterResourceBudgets(row.resource_budget).filter(budget =>
      budget.start_min != null && budget.start_max != null && budget.end_min != null && budget.end_max != null
    )
    budgetRows.push({ chapterNumber, budgets })
    const diagnosis = {
      arc_phase: textField(row, 'arc_phase', `第 ${chapterNumber} 章`),
      dramatic_contract: contract,
      tension_plan: { level: tensionLevel, payoff_type: payoffType },
      emotion_contract: emotionContract
    }
    return {
      title: textField(row, 'title', `第 ${chapterNumber} 章`),
      outline,
      arcPhase: diagnosis.arc_phase,
      payoffRole,
      foreshadowTarget: String(row.foreshadow_target ?? '').trim() || null,
      nextHook: textField(row, 'next_hook', `第 ${chapterNumber} 章`),
      characters: normalizeCharacters(row.characters, chapterNumber),
      outlineDiagnosis: JSON.stringify(diagnosis),
      emotionContract,
      resourceBudgets: budgets
    }
  })
  validateResourceBudgets(input.workId, input.previousChapterId, budgetRows)
  return items
}

function formatRecentOutlineContext(workId: number): string {
  return volumeChapterDAO.listChaptersByWork(workId)
    .slice(-3)
    .map((chapter, index, rows) => `第 ${rows.length - index} 个最近章节：${chapter.title}\n${chapter.outline ?? ''}`)
    .join('\n\n')
}

async function generateChapterBatch(input: {
  workId: number
  goal: string
  volume: NovelVolumeContract
  start: number
  end: number
  correction?: string
  signal?: AbortSignal
}): Promise<NovelOutlineBatchItem[]> {
  const plan = loadWritingPlan(input.workId)
  const constraints = outlineConstraintsForWordTarget(plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER)
  const resourceConstraints = formatResourceConstraintsForPrompt(input.workId)
  const previousChapter = volumeChapterDAO.listChaptersByWork(input.workId).at(-1)
  const previousBudgets = new Map<string, ChapterResourceBudgetInput>()
  if (previousChapter) {
    for (const budget of resourceLedgerDAO.listBudgetsByChapter(input.workId, previousChapter.id)) {
      previousBudgets.set(budgetKey(budget), budget)
    }
  }
  const budgetExample = resourceBudgetExample(input.workId, previousBudgets)
  const outputExample = {
    startChapter: input.start,
    endChapter: input.end,
    chapters: [{
      chapterNumber: input.start,
      title: `第${input.start}章 标题`,
      outline: '按合同输出完整章节执行蓝图',
      arc_phase: 'setup',
      payoff_role: 'B',
      tension_level: 6,
      payoff_type: 'debt',
      dramatic_contract: {
        scene_promise: '本章场景承诺', protagonist_want: '主角目标', obstacle: '阻力', stakes: '失败代价',
        info_gap: '信息差', pressure_escalation: '压力升级', turn: '中段转折', irreversible_change: '不可逆变化',
        payoff_or_debt: '兑现或债务', next_question: '结尾问题'
      },
      emotion_contract: EMOTION_CONTRACT_JSON_SHAPE,
      foreshadow_target: '',
      next_hook: '下一章钩子',
      characters: ['主角'],
      resource_budget: budgetExample
    }]
  }
  const ctx = buildWorkContext(input.workId, { includeVolumes: true, includeCoreSettings: true })
  const response = await modelService.chat(
    withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_chapter_batch',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 14000,
      systemPrompt: [
        '你是长篇小说章节结构编辑。只输出合法 JSON 对象，不要 markdown、前言、总结或解释。',
        `只生成第 ${input.start}-${input.end} 章，不得生成范围外章节。`,
        goldenOutlineContract('novel', input.start, input.end),
        retentionPlanningRules('novel'),
        `每章大纲 ${constraints.charsMin}-${constraints.charsMax} 字，必须包含【开场状态】【必须覆盖】【禁止越界】【结尾落点】【连续性约束】。`,
        '每章必须有戏剧契约：目标、阻力、失败代价、中段转折、不可逆变化和结尾问题。',
        '每章必须有 emotion_contract：依恋锚点、事件意义、人物表里冲突、读者信息位置、有代价选择和跨章余波缺一不可。',
        'payoff_role 只允许 A/B/C；payoff_type 只允许 debt/partial/major/aftertaste；tension_level 为1-10。',
        resourceConstraints ? '每章必须为全书资源账本中可数值化的资源输出完整 resource_budget，起止区间必须承接上一章；境界、身份等枚举状态写入角色状态和戏剧契约，不得伪造数值区间。' : 'resource_budget 输出空数组。',
        'resource_budget 必须按账本逐项输出，owner 和 resource 必须与账本完全一致，禁止遗漏或改名。',
        `合法 JSON 结构示例：${JSON.stringify(outputExample)}`
      ].join('\n'),
      prompt: [
        `【用户目标】\n${input.goal.trim() || '自动策划一部长篇小说'}`,
        `【当前分卷合同】\n${JSON.stringify(input.volume, null, 2)}`,
        resourceConstraints,
        previousResourceBudgetContext(previousBudgets),
        input.correction ? `【上一次输出未通过合同校验，本次必须逐项修正】\n${input.correction}` : '',
        formatRecentOutlineContext(input.workId) ? `【最近章节，必须连续承接】\n${formatRecentOutlineContext(input.workId)}` : '',
        `【作品上下文】\n${ctx.text.slice(0, 12000)}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`章节情节批次生成失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, `第 ${input.start}-${input.end} 章批次`)
  return validateChapterBatch({
    parsed,
    start: input.start,
    end: input.end,
    outlineMin: constraints.charsMin,
    workId: input.workId,
    previousChapterId: previousChapter?.id ?? null
  })
}

async function assessGoldenThreeOutlineBatch(
  workId: number,
  goal: string,
  items: NovelOutlineBatchItem[],
  signal?: AbortSignal
): Promise<{ passed: boolean; score: number; issues: string[] }> {
  const firstThree = items.slice(0, 3)
  if (firstThree.length < 3) {
    return { passed: false, score: 0, issues: ['首批章节未完整包含第1至3章'] }
  }
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_golden_three_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1600,
      systemPrompt: [
        '你是长篇网文黄金前三章门禁主编。只输出合法 JSON，不要 markdown 或解释。',
        goldenOutlineContract('novel', 1, 3),
        retentionEvaluationRules('novel'),
        '必须联合判断三章是否形成“立钩子→扩承诺→首兑现”的连续因果链，而非分别给三篇大纲挑文笔问题。',
        'score 低于85或存在 blocking_issues 时 passed=false。',
        '格式：{"passed":false,"score":78,"blocking_issues":["第3章没有兑现前两章承诺"],"repair_direction":"可直接用于重生成的具体要求"}'
      ].join('\n'),
      prompt: [
        `【用户目标】\n${goal.trim() || '自动策划一部长篇小说'}`,
        `【黄金前三章大纲】\n${JSON.stringify(firstThree, null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`黄金前三章门禁失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, '黄金前三章门禁')
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
  const issues = Array.isArray(parsed.blocking_issues)
    ? parsed.blocking_issues.map(String).map(value => value.trim()).filter(Boolean)
    : []
  const direction = String(parsed.repair_direction ?? '').trim()
  if (parsed.passed !== true && direction) issues.push(direction)
  return {
    passed: parsed.passed === true && score >= 85 && issues.length === 0,
    score,
    issues
  }
}

export async function prepareNovelVolumePlan(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ volumes: number; revised: boolean }> {
  const targetChapters = loadWritingPlan(workId).targetChapters || 10
  const state = readNovelGoalState(workId)
  const compatibleOutline = state.novelOutline?.version === 2
    && state.novelOutline.targetChapters === targetChapters
    ? state.novelOutline
    : undefined
  if (!compatibleOutline && volumeChapterDAO.listChaptersByWork(workId).length > 0) {
    throw new NovelPipelineError(
      'PREREQUISITE_MISSING',
      '分卷规划规则已升级，但作品已有章节，不能自动重新分卷；请先备份并确认现有章节的迁移方式'
    )
  }
  let volumePlan = compatibleOutline?.volumePlan ?? []
  if (volumePlan.length === 0) {
    onProgress?.(`正在生成全书分卷大纲（${targetChapters} 章）`)
    volumePlan = await generateVolumePlan(workId, goal, targetChapters, signal)
    updateNovelGoalState(workId, {
      novelOutline: { version: 2, targetChapters, volumePlan },
      volumePlanChecked: false,
      volumeQualityReport: undefined,
      checkedChapterVolumes: undefined,
      pendingChapterVolumeGate: undefined,
      failure: undefined
    })
    onProgress?.(`全书分卷大纲已生成：${volumePlan.length} 卷`)
  } else {
    validateVolumePlan(volumePlan, targetChapters)
  }

  let revised = false
  const latestState = readNovelGoalState(workId)
  if (!latestState.volumePlanChecked) {
    let gateRound = 0
    let gate: Awaited<ReturnType<typeof diagnoseVolumePlan>> | undefined
    while (gateRound < MAX_GATE_REPAIR_ROUNDS) {
      gateRound++
      onProgress?.(`正在诊断 ${volumePlan.length} 卷之间的逻辑与质量（第 ${gateRound} 轮）`)
      gate = await diagnoseVolumePlan(workId, goal, volumePlan, signal)
      if (gate.passed) break
      revised = true
      onProgress?.(`分卷质量门禁未通过，正在第 ${gateRound} 轮整体修订全书分卷大纲`)
      volumePlan = await reviseVolumePlan(workId, goal, targetChapters, volumePlan, gate.report, signal)
    }
    if (!gate?.passed) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `全书分卷大纲连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未通过质量门禁，请调整设定或模型后重试`
      )
    }
    updateNovelGoalState(workId, {
      novelOutline: { version: 2, targetChapters, volumePlan },
      volumePlanChecked: true,
      volumeQualityReport: gate.report,
      checkedChapterVolumes: revised ? undefined : latestState.checkedChapterVolumes,
      pendingChapterVolumeGate: undefined
    })
  }
  materializeVolumePlan(workId, volumePlan)
  onProgress?.(`分卷质量门禁通过，已冻结 ${volumePlan.length} 卷`)
  return { volumes: volumePlan.length, revised }
}

export async function generateNextNovelOutlineBatch(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<NovelOutlineBatchResult> {
  const writingPlan = loadWritingPlan(workId)
  const targetChapters = writingPlan.targetChapters || 10
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  if (existing.length > targetChapters) {
    throw new NovelPipelineError('CONTRACT_INVALID', `现有章节数 ${existing.length} 超过目标章节数 ${targetChapters}`)
  }
  const state = readNovelGoalState(workId)
  const invalidExisting = existing.find(chapter =>
    !chapter.title?.trim()
    || !chapter.outline?.trim()
    || !chapter.outline_diagnosis?.trim()
    || !chapter.next_hook?.trim()
    || !['A', 'B', 'C'].includes(chapter.beat_role ?? '')
  )
  if (invalidExisting) {
    throw new NovelPipelineError(
      'PREREQUISITE_MISSING',
      `已有章节「${invalidExisting.title || invalidExisting.id}」缺少长篇章节合同，请先重建该章大纲后再继续目标循环`
    )
  }
  if (!state.novelOutline || state.novelOutline.targetChapters !== targetChapters || !state.volumePlanChecked) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', '分卷大纲尚未通过质量门禁，不能生成章节情节')
  }
  const volumePlan = validateVolumePlan(state.novelOutline.volumePlan, targetChapters)
  await ensurePleasureEngineMatchesVolumePlan(workId, goal, volumePlan, signal, onProgress)
  const alignedState = readNovelGoalState(workId)
  const requiredFingerprint = pleasureVolumeFingerprint(workId, volumePlan)
  const pleasureGate = validatePleasureEngineScale(workId)
  if (alignedState.pleasureVolumeFingerprint !== requiredFingerprint || !pleasureGate.valid) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', `爽点机制分卷映射门禁未通过：${pleasureGate.reason || '映射版本不一致'}`)
  }

  const checkCompletedVolume = async (contract: NovelVolumeContract): Promise<{ volume: string; score: number; rounds: number }> => {
    updateNovelGoalState(workId, { pendingChapterVolumeGate: contract.name })
    const result = await runVolumeChapterGate(workId, goal, contract, signal, onProgress)
    const latest = readNovelGoalState(workId)
    updateNovelGoalState(workId, {
      pendingChapterVolumeGate: undefined,
      checkedChapterVolumes: [...new Set([...(latest.checkedChapterVolumes ?? []), contract.name])]
    })
    return { volume: contract.name, ...result }
  }

  if (state.pendingChapterVolumeGate) {
    const pending = volumePlan.find(item => item.name === state.pendingChapterVolumeGate)
    if (!pending) throw new NovelPipelineError('CONTRACT_INVALID', `待诊断分卷不存在：${state.pendingChapterVolumeGate}`)
    await checkCompletedVolume(pending)
  }

  if (existing.length === targetChapters) {
    const finalVolume = volumePlan.at(-1)!
    const checked = readNovelGoalState(workId).checkedChapterVolumes ?? []
    const volumeGate = checked.includes(finalVolume.name) ? undefined : await checkCompletedVolume(finalVolume)
    return { created: 0, reused: existing.length, remaining: 0, complete: true, volumeGate }
  }

  const start = existing.length + 1
  const volume = volumePlan.find(item => start >= item.startChapter && start <= item.endChapter)
  if (!volume) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${start} 章不属于任何分卷合同`)
  const end = Math.min(volume.endChapter, start + OUTLINE_BATCH_SIZE - 1)
  onProgress?.(`正在生成章节情节第 ${start}-${end} 章（剩余 ${targetChapters - existing.length} 章）`)
  let correction = state.failure?.phase === 'generate_beats' ? state.failure.message : undefined
  let items: NovelOutlineBatchItem[] = []
  for (let round = 1; round <= MAX_GATE_REPAIR_ROUNDS; round++) {
    items = await generateChapterBatch({ workId, goal, volume, start, end, correction, signal })
    if (start !== 1 || end < 3) break
    onProgress?.(`正在执行黄金前三章联合门禁（第 ${round} 轮）`)
    const gate = await assessGoldenThreeOutlineBatch(workId, goal, items, signal)
    if (gate.passed) {
      onProgress?.(`黄金前三章联合门禁通过（${gate.score}分）`)
      break
    }
    if (round === MAX_GATE_REPAIR_ROUNDS) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `黄金前三章连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未通过门禁：${gate.issues.join('；') || `${gate.score}分`}`
      )
    }
    correction = `黄金前三章门禁未通过（${gate.score}分），必须整体重建第1至3章：${gate.issues.join('；')}`
    onProgress?.(`黄金前三章未通过（${gate.score}分），正在整体重建首批章节`)
  }
  const volumeIndex = volumePlan.findIndex(item => item.name === volume.name)
  novelOutlineDAO.commitBatch({
    workId,
    volumeName: volume.name,
    volumeDescription: volume.description,
    volumeSort: volumeIndex + 1,
    volumeStartChapter: volume.startChapter,
    volumeEndChapter: volume.endChapter,
    chapterStartSort: start - volume.startChapter + 1,
    items
  })

  const total = volumeChapterDAO.listChaptersByWork(workId).length
  if (total !== end) {
    throw new NovelPipelineError('CONTRACT_INVALID', `批次提交后章节总数异常：期望 ${end}，实际 ${total}`)
  }
  const volumeGate = end === volume.endChapter
    ? await checkCompletedVolume(volume)
    : undefined
  return {
    created: items.length,
    reused: existing.length,
    remaining: targetChapters - total,
    complete: total === targetChapters,
    range: { start, end },
    volumeGate
  }
}
