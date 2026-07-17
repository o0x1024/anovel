import type { QualityAiMetricKey } from './quality-ai-score'

export type ChapterDialogueMode = 'mute_interaction' | 'solo' | 'scene_driven'

export interface ChapterSceneBudget {
  label: string
  targetWords: number
}

export interface ChapterExecutionContractInput {
  chapterId: number
  chapterTitle: string
  chapterOrdinal: number
  volumeName?: string | null
  volumeGoal?: string | null
  outline?: string | null
  characterNames?: string[]
  characterSpeechStyles?: string[]
  wordTarget: number
}

export interface ChapterExecutionContract {
  chapterId: number
  chapterTitle: string
  chapterOrdinal: number
  volumeName: string
  volumeGoal: string
  wordTarget: number
  wordMin: number
  wordMax: number
  openingState: string
  requiredEvents: string[]
  forbiddenEvents: string[]
  endingState: string
  abilityConstraints: string
  characterNames: string[]
  dialogueMode: ChapterDialogueMode
  dialogueRange: [number, number]
  sceneBudgets: ChapterSceneBudget[]
  errors: string[]
  warnings: string[]
}

const TAGS = ['开场状态', '必须覆盖', '禁止越界', '结尾落点', '能力/状态约束', '连续性约束'] as const

function extractTaggedText(outline: string, tag: typeof TAGS[number]): string {
  const startToken = `【${tag}】`
  const start = outline.indexOf(startToken)
  if (start < 0) return ''
  const contentStart = start + startToken.length
  const next = TAGS
    .map(nextTag => outline.indexOf(`【${nextTag}】`, contentStart))
    .filter(pos => pos >= 0)
    .sort((a, b) => a - b)[0]
  return outline.slice(contentStart, next ?? outline.length).trim().slice(0, 1200)
}

function splitContractItems(text: string): string[] {
  if (!text) return []
  return text
    .split(/[；;。\n]+/)
    .map(item => item.trim().replace(/^[\d一二三四五六七八九十]+[.、)]\s*/, '').slice(0, 400))
    .filter(Boolean)
    .slice(0, 12)
}

function allocateSceneBudgets(wordTarget: number): ChapterSceneBudget[] {
  const phases = [
    { label: '开场状态与即时危机', weight: 0.15 },
    { label: '观察、阻力与现场证据', weight: 0.2 },
    { label: '人物判断、选择与代价', weight: 0.25 },
    { label: '核心动作或关系转折', weight: 0.25 },
    { label: '结尾落点与未完成态', weight: 0.15 }
  ]
  let allocated = 0
  return phases.map((phase, index) => {
    const targetWords = index === phases.length - 1
      ? Math.max(0, wordTarget - allocated)
      : Math.round(wordTarget * phase.weight)
    allocated += targetWords
    return { label: phase.label, targetWords }
  })
}

function normalizeComparable(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】]/g, '')
}

export function buildChapterExecutionContract(input: ChapterExecutionContractInput): ChapterExecutionContract {
  const outline = input.outline?.trim() ?? ''
  const wordTarget = Math.max(0, Math.round(input.wordTarget))
  const openingState = extractTaggedText(outline, '开场状态')
  const requiredEvents = splitContractItems(extractTaggedText(outline, '必须覆盖'))
  const forbiddenEvents = splitContractItems(extractTaggedText(outline, '禁止越界'))
  const endingState = extractTaggedText(outline, '结尾落点')
  const abilityConstraints = extractTaggedText(outline, '能力/状态约束')
  const characterNames = [...new Set((input.characterNames ?? []).map(name => name.trim()).filter(Boolean))]
  const dialogueEvidence = [outline, ...(input.characterSpeechStyles ?? [])].join('\n')
  const muteInteraction = /哑巴|不会说话|无法说话|全程无对话|全程没有对话|无声互动/.test(dialogueEvidence)
  const dialogueMode: ChapterDialogueMode = muteInteraction
    ? 'mute_interaction'
    : characterNames.length <= 1
      ? 'solo'
      : 'scene_driven'
  const dialogueRange: [number, number] = dialogueMode === 'mute_interaction'
    ? [0, 10]
    : dialogueMode === 'solo'
      ? [0, 15]
      : [10, 40]

  const errors: string[] = []
  const warnings: string[] = []
  if (wordTarget <= 0) errors.push('章节目标字数必须大于 0')
  if (!outline) errors.push('章节大纲为空，无法编译执行合同')
  if (!openingState) warnings.push('大纲没有显式【开场状态】，将以正文连续性状态为准')
  if (requiredEvents.length === 0) warnings.push('大纲没有可拆分的【必须覆盖】节点')
  if (!endingState) warnings.push('大纲没有显式【结尾落点】，将以章末钩子为准')
  if (muteInteraction) warnings.push('检测到无声互动章节：通用对话密度规则已由非语言互动质量替代')

  const forbiddenNormalized = forbiddenEvents.map(normalizeComparable).filter(Boolean)
  for (const event of requiredEvents) {
    const normalized = normalizeComparable(event)
    if (normalized && forbiddenNormalized.some(item => item === normalized)) {
      errors.push(`同一事件同时出现在【必须覆盖】与【禁止越界】：${event}`)
    }
  }

  return {
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    chapterOrdinal: input.chapterOrdinal,
    volumeName: input.volumeName?.trim() ?? '',
    volumeGoal: input.volumeGoal?.trim() ?? '',
    wordTarget,
    wordMin: Math.round(wordTarget * 0.9),
    wordMax: Math.round(wordTarget * 1.1),
    openingState,
    requiredEvents,
    forbiddenEvents,
    endingState,
    abilityConstraints,
    characterNames,
    dialogueMode,
    dialogueRange,
    sceneBudgets: allocateSceneBudgets(wordTarget),
    errors,
    warnings
  }
}

export function formatChapterExecutionContract(contract: ChapterExecutionContract): string {
  const dialogueRule = contract.dialogueMode === 'mute_interaction'
    ? `本章以动作、眼神、递物和空间反应承载互动；禁止为了对话指标让不会说话的角色开口。对话占比允许 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%。`
    : contract.dialogueMode === 'solo'
      ? `本章允许少对话或无对话，优先保证行动和内心判断自然；对话占比允许 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%。`
      : `对话只在推动冲突、信息或关系时使用，参考区间 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%，不得为比例硬塞台词。`
  return [
    '【本章执行合同 - 优先级高于通用文风偏好】',
    `章节：第${contract.chapterOrdinal}章 ${contract.chapterTitle}`,
    contract.volumeName ? `当前卷：${contract.volumeName}` : '',
    contract.volumeGoal ? `当前卷目标：${contract.volumeGoal}` : '',
    `字数范围：${contract.wordMin}-${contract.wordMax}字，目标约${contract.wordTarget}字`,
    contract.openingState ? `开场状态：${contract.openingState}` : '',
    contract.requiredEvents.length ? `必须覆盖：\n${contract.requiredEvents.map((item, i) => `${i + 1}. ${item}`).join('\n')}` : '',
    contract.forbiddenEvents.length ? `禁止越界：\n${contract.forbiddenEvents.map((item, i) => `${i + 1}. ${item}`).join('\n')}` : '',
    contract.endingState ? `结尾状态：${contract.endingState}` : '',
    contract.abilityConstraints ? `能力/状态约束：${contract.abilityConstraints}` : '',
    contract.characterNames.length ? `本章角色：${contract.characterNames.join('、')}` : '',
    `互动模式：${dialogueRule}`,
    '【场景字数预算 - 在既定情节内展开，不得新增支线】',
    ...contract.sceneBudgets.map((item, i) => `${i + 1}. ${item.label}：约${item.targetWords}字（允许±20%）`),
    '冲突处理：章节事实与边界 > 连续性和能力限制 > 字数范围 > 通用文风偏好。若规则冲突，执行本合同。'
  ].filter(Boolean).join('\n')
}

export function adaptBodyStyleTextForContract(text: string, contract: ChapterExecutionContract): string {
  if (!text.trim()) return text
  const dialogueLine = contract.dialogueMode === 'mute_interaction'
    ? `- 本章为无声互动场景，对话占比允许 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%；用动作、眼神、递物和选择呈现关系，禁止强塞台词。`
    : contract.dialogueMode === 'solo'
      ? `- 本章允许少对话或无对话，对话占比允许 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%；不要为了比例制造自言自语。`
      : `- 对话密度服从本章冲突需要，参考 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%，不得为比例硬塞台词。`
  const lines = text.split('\n')
  const adapted = lines.map(line => /对话(?:占比|密度).*\d+%|对话占比须/.test(line) ? dialogueLine : line)
  return [
    '【章节合同覆盖规则】通用文风与本章执行合同冲突时，以本章角色能力、情节边界和互动模式为准。',
    ...adapted
  ].join('\n')
}

export function formatChapterQualityOverride(contract: ChapterExecutionContract): string {
  const interactionRule = contract.dialogueMode === 'mute_interaction'
    ? '本章是无声互动场景。对话少或没有对话不得扣分；应评估动作、眼神、递物、空间距离和选择是否完成互动与关系变化。'
    : contract.dialogueMode === 'solo'
      ? '本章允许少对话或无对话。不得因为独处场景对话不足而扣分。'
      : `本章对话参考区间为 ${contract.dialogueRange[0]}%-${contract.dialogueRange[1]}%，对话是否有效优先于比例。`
  return [
    '【本章动态评分覆盖规则 - 优先于通用比例】',
    interactionRule,
    `字数由系统按 ${contract.wordMin}-${contract.wordMax} 字判断；只有偏差超过25%才是字数硬失败。`,
    'AI句式、句长、短句和环境比例属于软质量项，不得单独触发 hard_fail。',
    'hard_fail 只用于：关键大纲缺失、严重逻辑/设定矛盾、能力越界、结尾越界、字数偏差超过25%。'
  ].join('\n')
}

export interface NovelQualityMetricScore {
  key: QualityAiMetricKey
  label: string
  score: number
}

export interface NovelQualityAcceptanceInput {
  scoreTotal: number
  hardFail: boolean
  items: NovelQualityMetricScore[]
  actualWordCount: number
  qualityMin: number
  qualityMetricMins: Record<QualityAiMetricKey, number>
  contract: ChapterExecutionContract
}

export interface NovelQualityAcceptance {
  passed: boolean
  acceptedWithinTolerance: boolean
  blockingFailures: string[]
  advisoryFailures: string[]
  acceptanceFloor: number
}

const NOVEL_CRITICAL_METRICS = new Set<QualityAiMetricKey>([
  'outline_coverage',
  'content_logic',
  'setting_consistency'
])

const NOVEL_HARD_FAILURE_PATTERN = /关键大纲|大纲节点缺失|严重逻辑|逻辑矛盾|设定矛盾|违反.*(?:能力|金手指)|能力越界|结尾越界|提前兑现|字数偏差|严重不足|严重超标|视角越界/

export function isRecognizedNovelHardFail(hardFail: boolean, failedRules: string[]): boolean {
  if (!hardFail) return false
  return failedRules.some(rule => NOVEL_HARD_FAILURE_PATTERN.test(rule))
}

export function evaluateNovelQualityAcceptance(input: NovelQualityAcceptanceInput): NovelQualityAcceptance {
  const blockingFailures: string[] = []
  const advisoryFailures: string[] = []
  const criticalFloor = Math.max(60, input.qualityMin - 10)
  const acceptanceFloor = Math.max(65, input.qualityMin - 5)

  if (input.hardFail) blockingFailures.push('存在质量硬失败项')
  const severeWordMin = Math.round(input.contract.wordTarget * 0.75)
  const severeWordMax = Math.round(input.contract.wordTarget * 1.25)
  if (input.actualWordCount < severeWordMin || input.actualWordCount > severeWordMax) {
    blockingFailures.push(`字数严重越界 ${input.actualWordCount}/${input.contract.wordMin}-${input.contract.wordMax}`)
  }

  for (const item of input.items) {
    const configured = input.qualityMetricMins[item.key]
    if (NOVEL_CRITICAL_METRICS.has(item.key)) {
      const threshold = Math.min(configured, criticalFloor)
      if (item.score < threshold) blockingFailures.push(`${item.label} ${item.score}/${threshold}`)
      continue
    }
    if (item.key === 'dialogue_density' && input.contract.dialogueMode !== 'scene_driven') continue
    if (item.score < configured) advisoryFailures.push(`${item.label} ${item.score}/${configured}`)
  }
  if (input.scoreTotal < acceptanceFloor) {
    blockingFailures.push(`质量总分 ${input.scoreTotal}/${acceptanceFloor}（目标${input.qualityMin}）`)
  }

  const passed = blockingFailures.length === 0
  return {
    passed,
    acceptedWithinTolerance: passed && input.scoreTotal < input.qualityMin,
    blockingFailures: [...new Set(blockingFailures)],
    advisoryFailures: [...new Set(advisoryFailures)],
    acceptanceFloor
  }
}

export interface NovelBodyCandidateRank {
  hardFail: boolean
  blockingFailures: number
  scoreTotal: number
  wordCount: number
  targetWords: number
}

export function isBetterNovelBodyCandidate(
  candidate: NovelBodyCandidateRank,
  best: NovelBodyCandidateRank | null
): boolean {
  if (!best) return true
  if (candidate.hardFail !== best.hardFail) return !candidate.hardFail
  if (candidate.blockingFailures !== best.blockingFailures) {
    return candidate.blockingFailures < best.blockingFailures
  }
  const candidateWordSafe = Math.abs(candidate.wordCount - candidate.targetWords) <= candidate.targetWords * 0.25
  const bestWordSafe = Math.abs(best.wordCount - best.targetWords) <= best.targetWords * 0.25
  if (candidateWordSafe !== bestWordSafe) return candidateWordSafe
  if (candidate.scoreTotal !== best.scoreTotal) return candidate.scoreTotal > best.scoreTotal
  return Math.abs(candidate.wordCount - candidate.targetWords) < Math.abs(best.wordCount - best.targetWords)
}
