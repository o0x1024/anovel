import { BrowserWindow, type WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import {
  volumeChapterDAO,
  goalRoutineDAO,
  coreSettingDAO,
  workDAO,
  appPreferenceDAO,
  storyHarnessDAO
} from '../../db'
import { modelService } from '../../model'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { buildWorkContext } from '../work-context'
import {
  parseCharacterCardsFromAi,
  sanitizeCharacterCards,
  saveCharacterCards,
  validateCharacterCards
} from '../character-cards'
import { buildSettingsQualityInput, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { runIncubatorGate } from '../incubator/gate-check'
import { runGateFix } from '../incubator/gate-fix'
import { freezeIncubatorStorylineVersion } from '../incubator/freeze-version'
import {
  parseChapterSuggestions,
  type ContinuityContract,
  type ParsedChapter
} from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../shared/story-incubator-prompts'
import { STORY_SLOT_KEYS, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'
import { parseExpansionVersions, type ExpansionVersion } from '../parse-expansion'
import { parseIncubatorVariants, type IncubatorVariant } from '../parse-variants'
import { updateDraftSlotContent } from '../incubator/update-slot'
import { extractJsonText } from '../parse-json-extract'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  failedCriticalStoryMetrics,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import {
  commitStoryBodyCandidate,
  generateBeatBody,
  extractNarrativeMemoryAfterGeneration
} from './story-goal-doer'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseStoryQualityAiScoreBreakdown } from '../../../shared/story-quality-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  getGoalLoopModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import { requestStructuredModelOutput } from './structured-model-output'
import {
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence
} from './quality-evaluator-policy'
import {
  GOAL_ROUTINE_PHASE_ORDER,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../shared/goal-routine-phases'
import {
  normalizeStoryCategoryTags,
  storyCategoryPromptSection,
  storyCategoryTagsToStorage,
  type StoryCategoryTags
} from '../../../shared/story-category-tags'
import { storyHotWordPromptSection } from '../../../shared/story-hot-words'
import { fuzzyReplace } from '../../../shared/fuzzy-match'
import { parseQualityConclusion, PASS_SCORE_THRESHOLD, type QualityConclusion } from '../settings-quality-conclusion'
import { selectPreferredTitleHook, compareRepairCandidate } from './story-pairwise-evaluator'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { recordTasteChoice } from '../taste-profile'
import { bodyWordCountBounds, countWords } from '../../../shared/body-word-target'
import { ensureStoryEngine } from './story-engine-gate'
import { ensureStoryContract, formatStoryContractForPrompt, getStoryContract } from './story-contract'
import { EMOTION_CONTRACT_JSON_SHAPE, ensureEmotionEngine } from './emotion-engine'
import {
  EMOTION_CONTRACT_ENUM_RULE,
  validateEmotionContract,
  type EmotionBlindAssessment
} from '../../../shared/emotion-contract'
import {
  assessChapterEmotion,
  emotionRepairHint,
  ensureChapterEmotionOutcome,
  EMOTION_GATE_MIN_SCORE
} from './emotion-gate'
import {
  formatGenrePolicy,
  normalizeTensionPlanForBeat,
  resolveStoryGenrePolicy,
  tensionCurveForBeat,
  validateTensionPlans
} from './story-genre-policy'
import {
  filterStoryRepairLedgerIssues,
  routeStoryForensicRepair,
  stalledStoryForensicEscalationCount
} from './story-forensic-repair'
import type { StoryForensicIssue } from './story-whole-evaluator'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateContractRepairIndexes,
  beatGateIssueSignature,
  beatGateIssuesForIndex,
  beatGateIssuesForLayer,
  beatGateNeedsSkeletonModelRepair,
  beatGateRepairIndexes,
  beatGateResolvedTargetCount,
  type BeatGateRecovery,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStagedBeat,
  mergeStoryBlueprintDiagnosis,
  sanitizeBeatSkeleton,
  storyBeatStageKey,
  synchronizeStoryBoundaryPairs
} from './story-beat-staging'
import { retentionEvaluationRules, retentionPackagingRules, retentionPlanningRules } from './reader-retention'
import {
  validateStoryBoundaryContracts,
  validateStoryContinuityContracts
} from '../../../shared/story-hard-guards'
import {
  routeStoryContinuityEscalation,
  type StoryContinuityEscalationRoute
} from './story-continuity-escalation'
import type { StoryContinuityRepairEvent } from './story-goal-doer'
import {
  STRUCTURAL_REPAIR_MAX_ATTEMPTS,
  STORY_ROUTINE_FAILURE_LIMIT,
  StructuralRepairError,
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from './story-structural-repair-policy'
import { GoalPhaseExhaustedError } from './goal-phase-error'
import {
  detectStoryTextIntegrityIssues,
  repairDeterministicStorySentences,
  resolveStoryModelCapability,
  stableStoryHash,
  storyHarnessIssueKey
} from '../../../shared/story-harness'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  patchStoryGoalRuntimeState as patchRuntimeState,
  readStoryGoalRuntimeState as readRuntimeState,
  type RepairPlan,
  type TitleHookCandidate
} from './story-goal-runtime'

export type { TitleHookCandidate } from './story-goal-runtime'


const MAX_BEAT_GENERATION_ROUNDS = 4

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

function buildBeatBatchSystemPrompt(wordsPerChapter: number, genreText: string, beatCount: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  const policy = resolveStoryGenrePolicy(genreText)
  const curve = Array.from({ length: beatCount }, (_, index) => {
    const point = tensionCurveForBeat(index + 1, beatCount)
    return `- 第${index + 1}拍：${point.phase}，张力 ${point.min}-${point.max}`
  }).join('\n')
  return [
    '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
    '【极度紧凑与高潮迭起约束 - 硬要求】',
    '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的"过渡节拍"或"日常水文"。',
    '全篇必须有张弛变化。低烈度蓄力拍可以存在，但必须改变线索、关系、认知、风险或现实条件；禁止每拍都强行高潮。',
    formatGenrePolicy(policy, 'beatRules'),
    retentionPlanningRules('story'),
    `【全篇张力曲线 - 必须逐拍执行】\n${curve}`,
    'tension_plan.level 必须落在对应拍区间；payoff_type 只能是 debt/partial/major/aftertaste。相邻两拍禁止无理由连续使用 major。',
    '【第一节拍黄金开局 - 硬约束】',
    'chapters 数组的第一项是全篇第一节拍，决定读者去留。必须满足：',
    '- 标题必须体现核心冲突场景（如"离婚协议甩在脸上"、"全家逼她跪下道歉"），禁止用背景介绍式标题。',
    '- plot_points 第一条必须是冲突的极端场景直接切入（不公/背叛/羞辱/悬念），禁止背景介绍、角色出场铺垫或日常开篇。',
    '- beat_role 必须是 B(推进冲突) 或 A(爽点释放)，禁止 C(反转铺垫)——第一节拍不允许慢热。',
    '- next_hook 必须是能让读者瞬间想看下一拍的强悬念。',
    '【每拍戏剧契约 - 防流水账硬约束】',
    '- 每个节拍都必须像一场戏，而不是事件摘要。必须明确：主角想要什么、谁阻止、失败代价、信息差、压力升级、中段转折、结尾后局面发生什么不可逆变化。',
    '- 如果某拍只是在交代背景、移动地点、解释设定、串联事件，没有不可逆变化，则该拍不合格，必须重设为冲突场。',
    '- dramatic_contract.scene_promise：本拍给读者承诺的爽点/悬念/情绪释放。',
    '- dramatic_contract.protagonist_want：主角此刻明确想得到/阻止/证明什么。',
    '- dramatic_contract.obstacle：具体阻力，必须是人、规则、误会、证据缺失或即时危险，不得写成泛泛困难。',
    '- dramatic_contract.stakes：失败会立刻失去什么，必须具体。',
    '- dramatic_contract.info_gap：读者与角色、主角与对手之间的信息差；没有信息差也要写清"无，靠正面对抗推进"。',
    '- dramatic_contract.pressure_escalation：本拍中压力如何升级，不能只维持原状。',
    '- dramatic_contract.turn：中段揭示/反转/选择，必须改变读者对局面的判断。',
    '- dramatic_contract.irreversible_change：本拍结束后局面发生的不可逆变化，这是防流水账的核心字段。',
    '- dramatic_contract.payoff_or_debt：本拍兑现了什么爽点，或欠下什么更大的情绪债。',
    '- dramatic_contract.next_question：读者结尾最想立刻知道的问题，必须与 next_hook 一致。',
    '【跨拍连续性合同 - 硬约束】',
    '- 每拍必须输出 continuity_contract，明确时间、起止地点、入场/离场事实、人物新获信息、证据或道具状态变化。',
    '- 每拍必须输出 entry_boundary 与 exit_boundary。它们是短而完整的权威状态键；第 i 拍 exit_boundary 必须与第 i+1 拍 entry_boundary 字面完全相等。',
    '- 第二拍起 elapsed_from_previous 必须明确；上一拍 exit_facts 必须能与下一拍 entry_facts 无矛盾衔接，已经发生的关键事件不得换个说法再次发生。',
    '- 中段节拍必须写 opponent_action、opponent_reasoning、damage_to_protagonist、protagonist_adjustment；对手必须造成真实损害，主角必须因此调整计划。',
    '- recap_forbidden 列出读者已经知道、正文不得再次完整复述的信息。',
    '- 最后一拍必须回收全篇故事合同的 must_resolve，不得引入 forbidden_final_threads；next_question 可以为空，余味不能变成新主线。',
    '【每拍情绪契约 - 读者状态变化硬约束】',
    '- emotion_contract 不是情绪标签，必须形成“依恋依据→触发→人物评价→表里冲突→选择与代价→读者推断→余波”。',
    '- 每拍必须区分人物真实感受、愿意承认、对外表现和压抑内容；四项不得写成同义句。',
    '- private_detail_anchor 必须是该人物/关系独有的物件、习惯或共同记忆，禁止心跳、瞳孔、攥拳等通用反应。',
    '- reader_state_before/after 必须有可解释变化；低唤醒拍必须承担依恋、预感、亲密、羞耻或余味功能。',
    `- ${EMOTION_CONTRACT_ENUM_RULE}。不得创造 climax、resolution 等近义枚举。`,
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一个节拍（请勿输出"第X章"或"节拍X"字样，直接写节拍剧情标题即可）。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、dramatic_contract、continuity_contract、tension_plan、emotion_contract、beat_role、foreshadow_target、next_hook、pov_mode、characters（本章出场角色名数组）。`,
    'pov_mode 必须沿用事件骨架冻结值，只能是 first、third_limited、omniscient；全篇不得切换。',
    'beat_role: A(爽点释放)/B(推进冲突)/C(反转铺垫)，禁止使用 transition',
    `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wordsPerChapter} 字正文），禁止正文级长文。`,
    `emotion_contract 格式：${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)}`,
    `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"dramatic_contract":{"scene_promise":"...","protagonist_want":"...","obstacle":"...","stakes":"...","info_gap":"...","pressure_escalation":"...","turn":"...","irreversible_change":"...","payoff_or_debt":"...","next_question":"..."},"continuity_contract":{"entry_boundary":"与上一拍 exit_boundary 完全相同；第一拍写 START","exit_boundary":"与下一拍 entry_boundary 完全相同；最终拍写 END","time_anchor":"...","elapsed_from_previous":"...","start_location":"...","end_location":"...","entry_facts":["..."],"exit_facts":["..."],"knowledge_changes":["..."],"evidence_changes":["..."],"opponent_action":"...","opponent_reasoning":"...","damage_to_protagonist":"...","protagonist_adjustment":"...","recap_forbidden":["..."]},"tension_plan":{"phase":"蓄力与受阻","level":6,"payoff_type":"debt"},"emotion_contract":${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)},"beat_role":"B","foreshadow_target":"...","next_hook":"...","pov_mode":"first","characters":["角色A","角色B"]}]}`
  ].join('\n')
}

const BEAT_STAGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'plot_points'],
        properties: {
          title: { type: 'string' },
          plot_points: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
}

/**
 * 第一阶段只决定全篇事件链，避免模型在同一次请求里为所有节拍展开几十个合同字段。
 */
function buildBeatSkeletonSystemPrompt(wordsPerChapter: number, genreText: string, beatCount: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  const policy = resolveStoryGenrePolicy(genreText)
  const curve = Array.from({ length: beatCount }, (_, index) => {
    const point = tensionCurveForBeat(index + 1, beatCount)
    return `- 第${index + 1}拍：${point.phase}，张力 ${point.min}-${point.max}`
  }).join('\n')
  return [
    '你是短故事节拍架构师。本阶段只生成全篇事件骨架，不生成正文，也不生成任何 contract 字段。',
    `必须恰好输出 ${beatCount} 个连续节拍；每拍都要改变关系、认知、风险、证据或权力状态。`,
    '第一拍直接进入核心冲突；中段必须出现对手有效反制并造成真实损害；最后一拍完成核心冲突和承诺回收。',
    '相邻节拍必须因果相接，已经发生的关键事件不得换个说法重复发生。',
    formatGenrePolicy(policy, 'beatRules'),
    retentionPlanningRules('story'),
    `【张力曲线】\n${curve}`,
    `每拍 plot_points 必须为 ${oc.pointsMin}-${oc.pointsMax} 条，总计 ${oc.charsMin}-${oc.charsMax} 字。`,
    '只输出合法 JSON，不要 Markdown、说明或思考过程。',
    '全篇叙事视角必须唯一且冻结。每拍 pov_mode 只能是 first、third_limited、omniscient；用户未指定时统一使用 first，禁止中途切换。',
    '只允许以下字段：title、plot_points、beat_role、foreshadow_target、next_hook、pov_mode、characters。',
    '格式：{"chapters":[{"title":"冲突场景标题","plot_points":["事件节点1","事件节点2","事件节点3"],"beat_role":"B","foreshadow_target":"伏笔或回收目标","next_hook":"下一拍具体问题","pov_mode":"first","characters":["角色A"]}]}'
  ].join('\n')
}

async function generateBeatStage(
  workId: number,
  volumeId: number,
  request: { prompt: string; systemPrompt: string; maxTokens: number },
  label: string,
  signal?: AbortSignal,
  validate?: (chapters: ParsedChapter[]) => string | null
): Promise<ParsedChapter[]> {
  return requestStructuredModelOutput<ParsedChapter[]>({
    workId,
    label,
    attempts: BEAT_STAGE_MAX_ATTEMPTS,
    signal,
    schema: BEAT_STAGE_RESPONSE_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          request.prompt,
          attempt > 1 ? `【上一请求失败】${lastError}\n请缩短表达并重新输出完整 JSON。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: request.systemPrompt,
        step: 'volume_chapters_batch',
        workId,
        volumeId,
        maxTokens: request.maxTokens,
        responseSchema: {
          name: label.includes('骨架') ? 'story_beat_skeletons' : 'story_beat_contract',
          schema: BEAT_STAGE_RESPONSE_SCHEMA,
          strict: false
        },
        structuredOutputMode: 'prompt_json',
        // basePrompt 已包含冻结故事合同；禁止再次灌入整套核心设定和分卷，避免重复上下文。
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    ),
    validate: value => {
      const chapters = parseChapterSuggestions(JSON.stringify(value))
      if (chapters.length === 0) throw new Error(`${label}返回 JSON 未包含有效 chapters`)
      const validationError = validate?.(chapters) ?? null
      if (validationError) throw new Error(validationError)
      return chapters
    }
  })
}

interface BeatGateResult {
  passed: boolean
  score: number
  blockingIssues: string[]
  suggestions: string[]
}

const BEAT_GATE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'score', 'blocking_issues', 'suggestions'],
  properties: {
    passed: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    blocking_issues: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } }
  }
}


function parseBeatGateResult(content: string): BeatGateResult {
  const jsonText = extractJsonText(content.trim()) ?? content.trim()
  const parsed = JSON.parse(jsonText) as Record<string, unknown>
  if (
    typeof parsed.passed !== 'boolean'
    || !Number.isFinite(Number(parsed.score))
    || !Array.isArray(parsed.blocking_issues)
    || !Array.isArray(parsed.suggestions)
  ) {
    throw new Error('节拍门禁协议缺少 passed、score、blocking_issues 或 suggestions')
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))))
  return {
    passed: parsed.passed,
    score,
    blockingIssues: parsed.blocking_issues.map(v => String(v).trim()).filter(Boolean),
    suggestions: parsed.suggestions.map(v => String(v).trim()).filter(Boolean)
  }
}

function buildBeatGatePrompt(goalDescription: string, chapters: ParsedChapter[]): string {
  const authorityCurve = chapters.map((_, index) => {
    const expected = tensionCurveForBeat(index + 1, chapters.length)
    return `第${index + 1}拍：${expected.phase}，允许 ${expected.min}-${expected.max}`
  }).join('\n')
  return [
    goalDescription.trim() ? `【用户创作目标】\n${goalDescription.trim()}` : '',
    `【权威张力曲线 - 允许蓄力回落，禁止要求逐拍单调递增】\n${authorityCurve}`,
    '【待门禁节拍】',
    JSON.stringify(chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      plot_outline: chapter.outline,
      beat_role: chapter.beat_role,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      dramatic_contract: chapter.dramatic_contract,
      tension_plan: chapter.tension_plan,
      emotion_contract: chapter.emotion_contract,
      continuity_contract: chapter.continuity_contract
    })), null, 2)
  ].filter(Boolean).join('\n\n')
}

async function runBeatGate(
  workId: number,
  goalDescription: string,
  chapters: ParsedChapter[],
  signal?: AbortSignal
): Promise<BeatGateResult> {
  assertNotAborted(signal)
  const tensionIssues = validateTensionPlans(chapters)
  const continuityIssues = validateStoryContinuityContracts(chapters)
  const emotionIssues = chapters.flatMap((chapter, index) => chapter.emotion_contract
    ? validateEmotionContract(chapter.emotion_contract, { isFinalBeat: index === chapters.length - 1 }).map(issue => `第${index + 1}拍${issue}`)
    : [`第${index + 1}拍缺少 emotion_contract`])
  const povModes = chapters.map(chapter => chapter.pov_mode?.trim() ?? '')
  const allowedPovModes = new Set(['first', 'third_limited', 'omniscient'])
  const povIssues = chapters.flatMap((chapter, index) => {
    const mode = chapter.pov_mode?.trim() ?? ''
    if (!mode) return [`第${index + 1}拍缺少 pov_mode，无法冻结全篇叙事视角`]
    return allowedPovModes.has(mode) ? [] : [`第${index + 1}拍 pov_mode=${mode} 非法`]
  })
  if (new Set(povModes.filter(Boolean)).size > 1) {
    povIssues.push(`全篇 pov_mode 不一致：${[...new Set(povModes.filter(Boolean))].join('、')}`)
  }
  if (tensionIssues.length > 0 || emotionIssues.length > 0 || continuityIssues.length > 0 || povIssues.length > 0) {
    return {
      passed: false,
      score: 60,
      blockingIssues: [...tensionIssues, ...emotionIssues, ...continuityIssues, ...povIssues],
      suggestions: ['按全篇张力曲线重分 tension_plan，为每拍重建完整情绪因果与跨拍连续性合同，并统一冻结 pov_mode']
    }
  }
  const evidence = await requestQualityEvaluatorEvidence<BeatGateResult>({
    workId,
    label: '短故事节拍门禁',
    signal,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
      prompt: [
        buildBeatGatePrompt(goalDescription, chapters),
        attempt > 1 ? `【上次取证协议错误】\n${lastError}` : ''
      ].filter(Boolean).join('\n\n'),
      systemPrompt: [
        '你是短故事节拍门禁主编。你的任务是在正文生成前拦截会导致流水账的节拍大纲。',
        '只输出合法 JSON，不要输出 markdown、解释或代码块。',
        '',
        '【硬性通过条件】',
        '1. 每拍都必须有完整 dramatic_contract，尤其是 protagonist_want、obstacle、stakes、pressure_escalation、turn、irreversible_change；仅最终拍允许 next_question 为空。',
        '2. 每拍必须是一场有目标、阻力、选择和后果的戏，不能只是事件顺序、设定解释、地点移动或背景补充。',
        '3. 每拍结尾必须让局面发生不可逆变化；非最终拍的 next_question/next_hook 必须驱动追读，最终拍必须闭环且不得强行续钩子。',
        '4. 张力必须严格遵守用户提示中的权威曲线；曲线允许蓄力拍回落，不得擅自要求逐拍单调递增。因果压力仍须持续推进。',
        '5. 第一拍必须直接切入极端冲突，不能慢热铺垫。',
        '6. 每拍必须有 tension_plan；level 建议不得越过权威曲线范围。全篇必须存在蓄力、部分兑现、高潮兑现和余味。',
        '7. 每拍必须有完整 emotion_contract；读者依恋、事件意义、人物表里冲突、有代价选择和下一拍余波缺一不可。',
        '8. 每拍必须有完整 continuity_contract；逐拍核对时间、地点、已完成事件、人物知识和证据状态，相邻拍存在矛盾即 blocking issue。',
        '9. 中段必须有基于对手已知信息的有效反制，并实际破坏主角计划；只有挑衅、自曝、下跪或等待主角公布证据不算反制。',
        '10. 最终拍必须完成核心冲突和承诺回收，不得突然引入新反派、新任务或续集钩子。',
        '11. 全篇 pov_mode 必须唯一；第一人称、第三人称限知、全知视角不得跨拍漂移。',
        retentionEvaluationRules('story'),
        '',
        '【评分】',
        'score 0-100，85 分以下或存在 blocking_issues 时 passed=false。',
        'blocking_issues 必须写清第几拍、缺什么、为什么会导致流水账。',
        'suggestions 必须给出可直接用于下一轮重生的改法。',
        '输出格式：{"passed":false,"score":70,"blocking_issues":["第2拍缺少不可逆变化..."],"suggestions":["把第2拍改成..."]}'
      ].join('\n'),
      step: 'story_beat_gate',
      workId,
      responseSchema: {
        name: 'story_beat_gate',
        schema: BEAT_GATE_RESPONSE_SCHEMA,
        strict: true
      },
      structuredOutputMode: 'prompt_json',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    ),
    parse: parseBeatGateResult
  })
  const parsed = requireQualityEvaluatorEvidence(evidence, '短故事节拍门禁')
  if (parsed.score < 85 && parsed.passed) {
    return { ...parsed, passed: false, blockingIssues: parsed.blockingIssues.length > 0 ? parsed.blockingIssues : [`门禁分 ${parsed.score} 低于 85`] }
  }
  if (parsed.blockingIssues.length > 0 && parsed.passed) {
    return { ...parsed, passed: false }
  }
  return parsed
}

function formatBeatGateFeedback(gate: BeatGateResult): string {
  return [
    `上一轮节拍门禁未通过，得分 ${gate.score}。`,
    gate.blockingIssues.length > 0 ? `阻塞问题：\n${gate.blockingIssues.map(x => `- ${x}`).join('\n')}` : '',
    gate.suggestions.length > 0 ? `重生要求：\n${gate.suggestions.map(x => `- ${x}`).join('\n')}` : '',
    '只修复阻塞问题明确指出的字段；未被点名且已通过的合同字段必须保持不变。'
  ].filter(Boolean).join('\n')
}

function cloneBeatChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  return JSON.parse(JSON.stringify(chapters)) as ParsedChapter[]
}

function beatRepairNeighborhood(chapters: ParsedChapter[], index: number): Array<Record<string, unknown>> {
  return chapters
    .slice(Math.max(0, index - 1), Math.min(chapters.length, index + 2))
    .map((chapter, offset) => ({
      index: Math.max(0, index - 1) + offset + 1,
      title: chapter.title,
      plot_outline: chapter.outline,
      next_hook: chapter.next_hook,
      dramatic_contract: chapter.dramatic_contract,
      continuity_contract: chapter.continuity_contract,
      emotion_information_position: chapter.emotion_contract?.information_position ?? null
    }))
}

async function repairBeatSkeletons(
  workId: number,
  volumeId: number,
  skeletons: ParsedChapter[],
  current: ParsedChapter[],
  issues: string[],
  context: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<Set<number>> {
  const modelIssues = issues.filter(beatGateNeedsSkeletonModelRepair)
  const indexes = beatGateRepairIndexes(modelIssues, skeletons.length)
  const repaired = new Set<number>()
  for (const index of indexes) {
    const scopedIssues = beatGateIssuesForIndex(modelIssues, index, skeletons.length)
    if (scopedIssues.length === 0) continue
    onProgress?.(`正在重写第 ${index + 1} 拍事件骨架（保留其余节拍）`)
    const candidates = await generateBeatStage(workId, volumeId, {
      systemPrompt: [
        '你是短故事事件骨架修复编辑。本次只重写指定的一拍，只输出包含一个元素的 chapters 数组。',
        'title 和 pov_mode 必须原样保留；只允许输出 title、plot_points、beat_role、foreshadow_target、next_hook、pov_mode、characters。',
        '修复触发机制、因果铺垫、事件可信度或最终闭环问题；不得改写其他节拍已经确定的事实。',
        index === skeletons.length - 1
          ? '这是最终拍：必须完成核心冲突，next_hook 必须为空，plot_points 不得包含章末钩子、续集问题或未来任务。'
          : '非最终拍的 next_hook 必须由本拍结果自然产生。',
        '只输出合法 JSON，不要 Markdown、说明或思考过程。'
      ].join('\n'),
      prompt: [
        context,
        `【全篇事件骨架 - 只读】\n${JSON.stringify(compactBeatSkeletons(skeletons), null, 2)}`,
        `【相邻拍当前事实状态 - 必须保持一致】\n${JSON.stringify(beatRepairNeighborhood(current, index), null, 2)}`,
        `【只修复第 ${index + 1} 拍】\n${JSON.stringify(compactBeatSkeletons([skeletons[index]])[0], null, 2)}`,
        `【必须解决的问题】\n${scopedIssues.map(issue => `- ${issue}`).join('\n')}`
      ].join('\n\n'),
      maxTokens: BEAT_CONTRACT_MAX_TOKENS
    }, `第 ${index + 1} 拍骨架修复`, signal,
    chapters => exactStageCountError(chapters.length, 1, '单拍骨架修复返回'))
    const candidate = candidates[0]
    skeletons[index] = sanitizeBeatSkeleton({
      ...skeletons[index],
      title: skeletons[index].title,
      outline: candidate.outline,
      beat_role: candidate.beat_role ?? skeletons[index].beat_role,
      foreshadow_target: candidate.foreshadow_target ?? skeletons[index].foreshadow_target,
      next_hook: candidate.next_hook ?? skeletons[index].next_hook,
      pov_mode: skeletons[index].pov_mode ?? candidate.pov_mode,
      characters: candidate.characters ?? skeletons[index].characters
    }, index === skeletons.length - 1)
    repaired.add(index)
  }
  return repaired
}

async function generateBeatCandidatesWithGate(
  workId: number,
  volumeId: number,
  skeletonSystemPrompt: string,
  contractSystemPrompt: string,
  basePrompt: string,
  goalDescription: string,
  beatCount: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ chapters: ParsedChapter[]; gate: BeatGateResult; rounds: number; degraded: boolean }> {
  const stageKey = storyBeatStageKey(basePrompt, beatCount)
  const storedRuntime = readRuntimeState(workId)
  const storedStage = storedRuntime.beatGenerationStage
  const resumableStage = storedStage?.key === stageKey && storedStage.skeletons.length === beatCount
    ? storedStage
    : undefined
  let gateFeedback = resumableStage?.gateFeedback ?? ''
  let skeletons = resumableStage?.skeletons
  const storedDraft = storedRuntime.beatGenerationDraft
  let best: { chapters: ParsedChapter[]; skeletons: ParsedChapter[]; gate: BeatGateResult; round: number } | null =
    storedDraft?.chapters.length === beatCount
      ? {
          chapters: cloneBeatChapters(storedDraft.chapters),
          skeletons: cloneBeatChapters(skeletons ?? storedDraft.chapters),
          gate: { passed: false, score: storedDraft.score, blockingIssues: storedDraft.issues, suggestions: [] },
          round: storedDraft.round
        }
      : null
  let parsed = resumableStage ? [...resumableStage.enriched] : []
  let repairIndexes = resumableStage?.repairIndexes
  let repairIssues = resumableStage?.gateIssues ?? []
  let previousIssueSignature = ''
  let stagnantIssueRounds = 0

  for (let round = resumableStage?.round ?? 1; round <= MAX_BEAT_GENERATION_ROUNDS; round++) {
    assertNotAborted(signal)
    const isResume = Boolean(skeletons)
    onProgress?.(isResume
      ? `正在定向补全 ${repairIndexes?.length ?? Math.max(0, beatCount - parsed.length)} 个问题节拍（第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮）`
      : `正在生成节拍骨架（第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮）`)
    const prompt = [
      basePrompt,
      gateFeedback ? `【上一轮门禁反馈 - 必须全部修复】\n${gateFeedback}` : ''
    ].filter(Boolean).join('\n\n')

    if (!skeletons) {
      skeletons = await generateBeatStage(workId, volumeId, {
          prompt,
          systemPrompt: skeletonSystemPrompt,
          maxTokens: BEAT_SKELETON_MAX_TOKENS
        }, '节拍骨架', signal, chapters => exactStageCountError(chapters.length, beatCount, '节拍骨架'))
      parsed = []
      repairIndexes = Array.from({ length: skeletons.length }, (_, index) => index)
    }

    // 最终拍闭环属于可确定执行的格式约束，先清除骨架文本中的章末钩子，
    // 避免后续契约修复永远无法触及被锁定的 plot_outline。
    skeletons = skeletons.map((chapter, index) => sanitizeBeatSkeleton(chapter, index === skeletons!.length - 1))
    parsed = parsed.map((chapter, index) => sanitizeBeatSkeleton(chapter, index === skeletons!.length - 1))
    // 定向补拍必须携带上一轮门禁反馈，否则会原样再生成同一个缺字段合同。
    const contractContext = prompt.replace(/\n请输出完整 chapters 数组。?\s*$/, '')
    const structuralRepaired = repairIssues.length > 0
      ? await repairBeatSkeletons(
          workId,
          volumeId,
          skeletons,
          parsed,
          beatGateIssuesForLayer(repairIssues, 'skeleton'),
          contractContext,
          signal,
          onProgress
        )
      : new Set<number>()
    const compactSkeletons = compactBeatSkeletons(skeletons)
    if (!isResume || parsed.length < skeletons.length) {
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey, round, gateFeedback, skeletons, enriched: parsed, repairIndexes, gateIssues: repairIssues, updatedAt: new Date().toISOString()
        }
      })
    }
    const contractIssues = beatGateIssuesForLayer(repairIssues, 'contract')
    const structuralContractIndexes = new Set<number>()
    for (const index of structuralRepaired) {
      if (index > 0) structuralContractIndexes.add(index - 1)
      structuralContractIndexes.add(index)
      if (index + 1 < skeletons.length) structuralContractIndexes.add(index + 1)
    }
    const routedRepairIndexes = repairIssues.length > 0
      ? [...new Set([
          ...beatGateContractRepairIndexes(contractIssues, skeletons.length),
          ...structuralContractIndexes
        ])].sort((left, right) => left - right)
      : []
    const indexesToRepair = routedRepairIndexes.length > 0
      ? routedRepairIndexes
      : repairIssues.length > 0
        ? []
        : repairIndexes?.length
          ? repairIndexes
          : Array.from({ length: skeletons.length - parsed.length }, (_, offset) => parsed.length + offset)
    for (const index of indexesToRepair) {
      assertNotAborted(signal)
      const skeleton = skeletons[index]
      let issueScope = beatGateIssuesForIndex(contractIssues, index, skeletons.length)
      if (structuralRepaired.has(index)) {
        issueScope = ['事件骨架已经定向改写：按新骨架重新生成全部合同，并与相邻拍事实状态保持一致']
      } else if (structuralContractIndexes.has(index)) {
        issueScope = ['相邻拍事件骨架已经改变：联动校准 continuity_contract 的事实、知识、时间、地点和证据状态']
      } else if (issueScope.length === 0 && contractIssues.some(issue => /continuity_contract|连续性|时间线|时间锚点|地点|人物认知|知识状态|entry_facts|knowledge_changes|info_gap|证据/.test(issue))) {
        issueScope = ['相邻拍 continuity_contract 联动校准：只修正与相邻拍冲突的事实、知识、时间、地点和证据状态']
      }
      onProgress?.(`正在补全节拍契约 ${index + 1}/${skeletons.length}（第 ${round} 轮）`)
      const candidates = await generateBeatStage(workId, volumeId, {
        systemPrompt: [
          contractSystemPrompt,
          '本次只补全指定的一个节拍。必须沿用给定 title 和事件骨架，只输出包含一个元素的 chapters 数组。',
          '不得扩写正文；所有文本字段用一句话完成。plot_points 只需将给定 plot_outline 压缩为 3-5 条。'
        ].join('\n\n'),
        prompt: [
          contractContext,
          `【全篇节拍骨架 - 只读】\n${JSON.stringify(compactSkeletons, null, 2)}`,
          parsed[index]
            ? `【当前合同与相邻拍事实状态 - 在此基础上定向修复】\n${JSON.stringify(beatRepairNeighborhood(parsed, index), null, 2)}`
            : '',
          `【当前只补全第 ${index + 1} 拍】\n${JSON.stringify(compactSkeletons[index], null, 2)}`,
          issueScope.length > 0 ? `【当前拍必须解决的问题】\n${issueScope.map(issue => `- ${issue}`).join('\n')}` : ''
        ].filter(Boolean).join('\n\n'),
        maxTokens: BEAT_CONTRACT_MAX_TOKENS
      }, `第 ${index + 1} 拍契约补全`, signal,
      chapters => exactStageCountError(chapters.length, 1, '单拍契约返回'))
      parsed[index] = normalizeTensionPlanForBeat(
        mergeStagedBeat(skeleton, candidates[0], {
          current: structuralRepaired.has(index) ? undefined : parsed[index],
          issues: issueScope,
          isFinalBeat: index === skeletons.length - 1
        }),
        index,
        skeletons.length
      )
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey, round, gateFeedback, skeletons, enriched: parsed, repairIndexes, gateIssues: repairIssues, updatedAt: new Date().toISOString()
        }
      })
    }

    // continuity_contract 分拍生成时，右拍不能自行改写上一拍已经确定的离场状态。
    // 将同一交接投影为共享边界后再执行门禁，避免为纯文本不等重复调用整组模型。
    parsed = synchronizeStoryBoundaryPairs(parsed)
    patchRuntimeState(workId, {
      beatGenerationStage: {
        key: stageKey,
        round,
        gateFeedback,
        skeletons,
        enriched: parsed,
        repairIndexes,
        gateIssues: repairIssues,
        updatedAt: new Date().toISOString()
      }
    })

    onProgress?.(`正在运行节拍 AI 门禁（第 ${round} 轮，达标前持续重生）`)
    const gate = await runBeatGate(workId, goalDescription, parsed, signal)
    const resolvedTargetCount = beatGateResolvedTargetCount(repairIssues, gate.blockingIssues, skeletons.length)
    const madeTargetedProgress = resolvedTargetCount > 0
      && (!best || gate.score >= best.gate.score - 5)
      && (!best || gate.blockingIssues.length <= best.gate.blockingIssues.length)
    // 通过硬门禁的候选永远优先于历史高分但仍有阻塞项的草稿。
    const shouldKeep = gate.passed
      || !best
      || gate.score > best.gate.score
      || (gate.score === best.gate.score && gate.blockingIssues.length < best.gate.blockingIssues.length)
      || madeTargetedProgress
    if (shouldKeep) best = { chapters: cloneBeatChapters(parsed), skeletons: cloneBeatChapters(skeletons), gate, round }
    else if (best) {
      parsed = cloneBeatChapters(best.chapters)
      skeletons = cloneBeatChapters(best.skeletons)
      onProgress?.(`本轮引入了更多问题，已回滚到 ${best.gate.score} 分最佳候选`)
    }
    if (best) {
      patchRuntimeState(workId, {
        beatGenerationDraft: {
          round: best.round,
          score: best.gate.score,
          issues: best.gate.blockingIssues,
          chapters: cloneBeatChapters(best.chapters),
          updatedAt: new Date().toISOString()
        }
      })
    }
    if (gate.passed) {
      patchRuntimeState(workId, { beatGenerationDraft: undefined, beatGenerationStage: undefined })
      onProgress?.(`节拍 AI 门禁通过（${gate.score}分，第 ${round} 轮）`)
      return { chapters: parsed, gate, rounds: round, degraded: false }
    }

    const repairGate = shouldKeep || !best ? gate : best.gate
    const issueSummary = gate.blockingIssues.slice(0, 2).join('；') || '未达到门禁标准'
    onProgress?.(`节拍门禁第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮未通过（${gate.score}分）：${issueSummary}`)
    const issueSignature = beatGateIssueSignature(gate.blockingIssues, skeletons.length)
    if (issueSignature && issueSignature === previousIssueSignature && !shouldKeep) stagnantIssueRounds++
    else stagnantIssueRounds = 0
    previousIssueSignature = issueSignature
    const noConvergence = stagnantIssueRounds >= 1
    if (round === MAX_BEAT_GENERATION_ROUNDS || noConvergence) {
      const fallback = best ?? { chapters: parsed, skeletons, gate, round }
      const fallbackIssues = fallback.gate.blockingIssues
      const fallbackIndexes = beatGateRepairIndexes(fallbackIssues, skeletons.length)
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey,
          round: 1,
          gateFeedback: formatBeatGateFeedback(fallback.gate),
          skeletons: cloneBeatChapters(fallback.skeletons),
          enriched: cloneBeatChapters(fallback.chapters),
          repairIndexes: fallbackIndexes.length > 0 ? fallbackIndexes : Array.from({ length: skeletons.length }, (_, index) => index),
          gateIssues: fallbackIssues,
          updatedAt: new Date().toISOString()
        }
      })
      throw new Error(
        noConvergence
          ? `节拍门禁连续 2 轮同类问题未收敛，禁止继续消耗调用；最佳候选 ${fallback.gate.score} 分：${fallbackIssues.join('；')}`
          : `节拍门禁连续 ${MAX_BEAT_GENERATION_ROUNDS} 轮未通过，禁止降级进入正文；最佳候选 ${fallback.gate.score} 分：${fallbackIssues.join('；')}`
      )
    }
    // parsed 已回滚到最佳草稿时，下一轮必须按该草稿自己的问题定向修复，
    // 不能拿被丢弃候选的问题去覆盖最佳草稿的字段。
    gateFeedback = formatBeatGateFeedback(repairGate)
    repairIssues = repairGate.blockingIssues
    // “第15拍缺 emotion_contract”这类局部错误只需要补第15拍，不能再付出整组 15 次调用。
    repairIndexes = beatGateRepairIndexes(repairGate.blockingIssues, skeletons.length)
    if (repairIndexes.length === 0) repairIndexes = Array.from({ length: skeletons.length }, (_, index) => index)
    patchRuntimeState(workId, {
      beatGenerationStage: {
        key: stageKey,
        round: round + 1,
        gateFeedback,
        skeletons,
        enriched: parsed,
        repairIndexes,
        gateIssues: repairIssues,
        updatedAt: new Date().toISOString()
      }
    })
  }

  throw new Error('节拍大纲生成未能在有限轮次内完成')
}

/** outline 阶段：若无节拍，生成节拍大纲并入库（注入创作目标） */
export async function ensureBeats(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ created: number; error?: string; warning?: string; recovery?: BeatGateRecovery; terminal?: boolean }> {
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  const runtime = readRuntimeState(workId)
  const forceBeatRebuild = runtime.forceBeatRebuild === true
  if (!forceBeatRebuild && existing.some(c => c.content?.trim())) return { created: 0 }
  if (!getStoryContract(workId)) {
    await ensureStoryContract(workId, goalDescription, '', signal, onProgress)
  }

  let volumes = volumeChapterDAO.listVolumes(workId)
  let volumeId = volumes[0]?.id
  if (!volumeId) {
    volumeId = volumeChapterDAO.createVolume(workId, '正文', '短故事主线剧情')
    volumes = volumeChapterDAO.listVolumes(workId)
  }

  const plan = loadWritingPlan(workId)
  const wpc = plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER
  const configuredCount = plan.targetChapters > 0
    ? Math.max(1, Math.round(plan.targetChapters))
    : 5
  // 断点续跑时，未完成的节拍骨架是已投入模型调用成本的唯一事实来源。
  // 不能因写作计划在此期间回落到默认值而把 15 拍的断点悄悄改成 5 拍并从头再来。
  const stagedBeatCount = !forceBeatRebuild ? runtime.beatGenerationStage?.skeletons?.length : undefined
  const suggestedCount = forceBeatRebuild && existing.length > 0
    ? existing.length
    : stagedBeatCount && stagedBeatCount > 0
      ? stagedBeatCount
      : configuredCount

  const vol = volumes[0]
  const work = workDAO.getById(workId)
  const genreText = [work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')
  const structuralFeedback = runtime.structuralFeedback?.trim() ?? ''
  onProgress?.(`正在生成节拍大纲（约 ${suggestedCount} 个节拍）`)
  const prompt = [
    `【短故事一镜到底】当前需要将其拆解为连续的情节节拍，共约 ${suggestedCount} 个节拍。`,
    formatStoryContractForPrompt(workId),
    goalDescription.trim() ? `【短故事创作目标】${goalDescription.trim()}，请据此拆解节拍（题材/风格/情节走向须贴合目标）` : '',
    structuralFeedback ? `【上一版整篇失败反馈 - 本轮必须从结构上解决】\n${structuralFeedback}` : '',
    vol.description ? `主线说明：${vol.description}` : '',
    '请输出完整 chapters 数组。'
  ].filter(Boolean).join('\n')

  let parsed: ParsedChapter[]
  let gateRounds = 0
  let gateWarning: string | undefined
  try {
    const gated = await generateBeatCandidatesWithGate(
      workId,
      volumeId,
      buildBeatSkeletonSystemPrompt(wpc, genreText, suggestedCount),
      buildBeatBatchSystemPrompt(wpc, genreText, suggestedCount),
      prompt,
      goalDescription,
      suggestedCount,
      signal,
      onProgress
    )
    parsed = gated.chapters
    gateRounds = gated.rounds
    if (gated.degraded) {
      gateWarning = `节拍门禁未达标，已自动采用最佳候选（${gated.gate.score}分）`
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (/节拍门禁连续/.test(error)) {
      // 一次生成周期已经最多经历四轮门禁；到这里继续从头重建只会把同一问题放大为数小时等待。
      return { created: 0, error, terminal: true }
    }
    return { created: 0, error }
  }

  const items = parsed.map(p => ({
    title: p.title,
    outline: p.outline ?? '',
    beat_role: p.beat_role ?? null,
    foreshadow_target: p.foreshadow_target ?? null,
    next_hook: p.next_hook ?? null,
    pov_mode: p.pov_mode ?? null,
    characters: p.characters ?? null,
    emotion_contract_json: p.emotion_contract ? JSON.stringify(p.emotion_contract) : null,
      outline_diagnosis: p.dramatic_contract || p.continuity_contract || p.tension_plan
        ? JSON.stringify({ dramatic_contract: p.dramatic_contract, continuity_contract: p.continuity_contract, tension_plan: p.tension_plan, emotion_contract: p.emotion_contract })
        : null
  }))
  if (forceBeatRebuild && existing.length === items.length) {
    volumeChapterDAO.rewriteStoryBeatsPreservingVersions(existing.map((chapter, index) => ({
      chapterId: chapter.id,
      ...items[index]
    })))
    existing.forEach(chapter => clearChapterNarrativeMemory(workId, chapter.id))
  } else {
    volumeChapterDAO.batchCreateChapters(volumeId, items, existing.length > 0 ? 'replace' : 'append')
  }
  if (structuralFeedback || forceBeatRebuild) {
    patchRuntimeState(workId, {
      structuralFeedback: undefined,
      forceBeatRebuild: undefined,
      beatGateFailureCount: undefined
    })
  }
  onProgress?.(`已回填 ${items.length} 个节拍到节拍大纲（门禁 ${gateRounds} 轮）`)
  return { created: items.length, warning: gateWarning }
}
