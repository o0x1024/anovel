export type StoryHarnessSeverity = 'blocker' | 'major' | 'minor'
export type StoryHarnessScope = 'sentence' | 'scene' | 'beat' | 'cluster' | 'engine'

export interface StoryHarnessIssue {
  code: string
  severity: StoryHarnessSeverity
  scope: StoryHarnessScope
  chapterIds?: number[]
  evidence: string[]
  message: string
  expectedResult: string
  invariants?: string[]
}

export interface StoryModelCapabilityProfile {
  mode: 'conservative' | 'balanced'
  maxContinuityRepairs: number
  maxIssueRepairs: number
  maxWholeAudits: number
  previousTailChars: number
  nextOpeningChars: number
  requiresNarrowEvaluation: boolean
}

export interface StoryModelCapabilityInput {
  modelName?: string | null
  thinkingEnabled?: boolean
}

export const STORY_HARNESS_MAX_CANDIDATES_PER_BEAT = 4

/** 只有正文语义/连续性失败才消耗结构候选预算；格式和派生索引失败由各自熔断器处理。 */
export function isStructuralStoryCandidateRejection(reason: string): boolean {
  return /连续性|时间|地点|空间|阻碍|证据|道具|合同|提前触发|状态倒退|资源数值门禁|章节一致性门禁/.test(reason)
    && !/叙事记忆提取|正文确定性门禁|泛白类/.test(reason)
}

export function derivedMemoryFailureDisposition(
  workType: 'novel' | 'story',
  aborted: boolean
): 'cancel' | 'block' | 'defer' {
  if (aborted) return 'cancel'
  // 正文是主产物，叙事记忆和模式指纹都可由同一份正文重算。
  // 长篇仍会在进入下一章前强制补齐指纹，但不得因此丢弃并重新生成正文。
  void workType
  return 'defer'
}

/** 修复模型流式拼接常见的孤立引号/单个未闭合中文引号，不改写任何叙事词句。 */
export function repairDeterministicStoryQuotes(text: string): string {
  const withoutIsolated = text
    .split(/\r?\n/)
    .filter(line => !/^[“”"']$/.test(line.trim()))
    .join('\n')
  let opened = false
  let repaired = ''
  let lastOpenIndex = -1
  for (const char of withoutIsolated) {
    if (char === '“') {
      if (opened) repaired += '”'
      repaired += char
      opened = true
      lastOpenIndex = repaired.length - 1
      continue
    }
    if (char === '”') {
      if (!opened) continue
      repaired += char
      opened = false
      continue
    }
    repaired += char
  }
  if (!opened) return repaired
  const lineEnd = repaired.indexOf('\n', lastOpenIndex)
  return lineEnd >= 0
    ? `${repaired.slice(0, lineEnd)}”${repaired.slice(lineEnd)}`
    : `${repaired}”`
}
export const STORY_HARNESS_MAX_AUTOMATION_EPOCHS = 2

export function canStartStoryFallbackEpoch(currentEpoch: number): boolean {
  return Number.isInteger(currentEpoch)
    && currentEpoch >= 0
    && currentEpoch + 1 < STORY_HARNESS_MAX_AUTOMATION_EPOCHS
}

export interface StoryCandidateContextInput {
  acceptedBody?: string | null
  outline?: string | null
  outlineDiagnosis?: string | null
  emotionContract?: string | null
  storyEngine?: string | null
  storyContract?: string | null
}

/**
 * 候选预算必须绑定完整生成上下文，而不是只绑定正式正文。只要发动机、
 * 合同或节拍蓝图发生变化，就开启新的候选额度，同时保留旧候选供审计。
 */
export function buildStoryCandidateContextSource(input: StoryCandidateContextInput): string {
  return JSON.stringify({
    schema: 1,
    acceptedBody: input.acceptedBody?.trim() ?? '',
    outline: input.outline?.trim() ?? '',
    outlineDiagnosis: input.outlineDiagnosis?.trim() ?? '',
    emotionContract: input.emotionContract?.trim() ?? '',
    storyEngine: input.storyEngine?.trim() ?? '',
    storyContract: input.storyContract?.trim() ?? ''
  })
}

export type StorySettingResolutionCode =
  | 'POVERTY_WEALTH_CONFLICT'
  | 'ADJUDICATOR_CONFLICT_OF_INTEREST'
  | 'DEADLINE_CONTRADICTION'

interface StorySettingSignals {
  povertyWealthConflict: boolean
  adjudicatorConflict: boolean
  deadlineValues: number[]
}

function inspectStorySettingSignals(source: string): StorySettingSignals {
  const compact = source.replace(/\s+/g, '')
  const poverty = /低保|贫困补助|特困补助|廉租房|靠低保维生/.test(compact)
  const wealth = /唯一继承人|财团继承人|集团继承人|顶尖珠宝财团|豪门继承人|家族全额捐建/.test(compact)
  const freelyRich = /捐(?:了|出|赠).{0,18}(?:十万|几十万|百万|十条.{0,8}项链)|随手.{0,12}捐/.test(compact)
  const adjudicatorConflict = /(?:爷爷|祖父).{0,20}(?:奥赛|竞赛|组委会).{0,12}(?:主席|评委|名誉主席)/.test(compact)
    && /(?:主角|我).{0,30}(?:奥赛|竞赛).{0,12}(?:满分|第一|冠军|保送)/.test(compact)
  const deadlineValues = [...compact.matchAll(/公示期(?:还|只)?剩?(\d{1,3})天/g)]
    .map(match => Number(match[1]))
  return {
    povertyWealthConflict: poverty && wealth && freelyRich,
    adjudicatorConflict,
    deadlineValues
  }
}

function taggedStoryResolution(code: StorySettingResolutionCode, text: string): string {
  return `[${code}] ${text}`
}

/**
 * 对能够由固定业务规则裁决的设定冲突生成权威口径。这里做确定性选择，
 * 不把“写一句恰好命中正则的自然语言”交给能力未知的生成模型。
 */
export function deriveRequiredStorySettingResolutions(source: string): string[] {
  const signals = inspectStorySettingSignals(source)
  const resolutions: string[] = []
  if (signals.povertyWealthConflict) {
    resolutions.push(taggedStoryResolution(
      'POVERTY_WEALTH_CONFLICT',
      '主角先正式退出低保，之后才取得并可支配家族财产；福利期与财富支配期不重叠。'
    ))
  }
  if (signals.adjudicatorConflict) {
    resolutions.push(taggedStoryResolution(
      'ADJUDICATOR_CONFLICT_OF_INTEREST',
      '亲属对主角相关竞赛的命题、评审、评分和成绩认定强制回避；成绩由无利益关系的独立机构复核认定。'
    ))
  }
  const distinctDeadlines = [...new Set(signals.deadlineValues)]
  if (distinctDeadlines.length > 1) {
    // 上游文本中的首个核心倒计时优先，避免弱模型在重试间随机改口径。
    resolutions.push(taggedStoryResolution(
      'DEADLINE_CONTRADICTION',
      `公示期统一以剩余${signals.deadlineValues[0]}天为准，其他公示期数字作废。`
    ))
  }
  return resolutions
}

function hasTaggedStoryResolution(source: string, code: StorySettingResolutionCode): boolean {
  return source.includes(`[${code}]`)
}

/**
 * 未知模型一律按保守档处理。只有显式开启推理时才放宽一次修复机会；
 * 不依赖厂商名猜能力，避免新模型或私有模型被误判为强模型。
 */
export function resolveStoryModelCapability(
  input: StoryModelCapabilityInput = {}
): StoryModelCapabilityProfile {
  const balanced = input.thinkingEnabled === true
  return balanced
    ? {
        mode: 'balanced',
        maxContinuityRepairs: 2,
        maxIssueRepairs: 2,
        maxWholeAudits: 3,
        previousTailChars: 1600,
        nextOpeningChars: 1200,
        requiresNarrowEvaluation: false
      }
    : {
        mode: 'conservative',
        maxContinuityRepairs: 1,
        maxIssueRepairs: 2,
        maxWholeAudits: 2,
        previousTailChars: 1000,
        nextOpeningChars: 800,
        requiresNarrowEvaluation: true
      }
}

function issue(
  code: string,
  scope: StoryHarnessScope,
  evidence: string[],
  message: string,
  expectedResult: string,
  severity: StoryHarnessSeverity = 'blocker'
): StoryHarnessIssue {
  return { code, severity, scope, evidence, message, expectedResult }
}

export function storyHarnessIssueKey(value: StoryHarnessIssue): string {
  const chapters = [...(value.chapterIds ?? [])].sort((a, b) => a - b).join(',')
  return `${value.code}:${value.scope}:${chapters}`
}

export function stableStoryHash(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** 不依赖模型的成稿完整性检查。 */
export function detectStoryTextIntegrityIssues(
  text: string,
  options: { chapterId?: number; finalBeat?: boolean } = {}
): StoryHarnessIssue[] {
  const issues: StoryHarnessIssue[] = []
  const chapterIds = options.chapterId == null ? undefined : [options.chapterId]
  const push = (value: StoryHarnessIssue) => issues.push({ ...value, chapterIds })
  const trimmed = text.trim()
  if (!trimmed) {
    push(issue('EMPTY_BODY', 'beat', ['正文为空'], '节拍正文为空，禁止提交正式章节', '生成非空且完整的正文'))
    return issues
  }

  const quoteCount = (trimmed.match(/[“”]/g) ?? []).length
  if (quoteCount % 2 !== 0) {
    push(issue(
      'UNBALANCED_QUOTES', 'sentence', [`中文引号数量为 ${quoteCount}`],
      '正文存在未闭合中文引号', '补齐或删除孤立引号，只改动对应句子'
    ))
  }

  const isolated = nonEmptyLines(trimmed).filter(line => /^[“”"']$/.test(line))
  if (isolated.length > 0) {
    push(issue(
      'ISOLATED_QUOTE', 'sentence', isolated.slice(0, 4),
      '正文存在孤立引号行', '删除孤立引号并保持相邻情节不变'
    ))
  }

  const dangling = nonEmptyLines(trimmed).filter(line =>
    /(?:除了|因为|所以|但是|然后|说|说道|问|回答|如果|只要|等到)[，,:：；;]?$/.test(line)
  )
  if (dangling.length > 0) {
    push(issue(
      'TRUNCATED_SENTENCE', 'sentence', dangling.slice(0, 4),
      '正文存在明显截断句', '补全承载的因果或对话；无法补全时删除残句'
    ))
  }

  const meta = nonEmptyLines(trimmed).filter(line =>
    /^(?:文风|写作要求|创作目标|节拍大纲|戏剧契约|本拍要求)[：:]/.test(line)
  )
  if (meta.length > 0) {
    push(issue(
      'META_RESIDUE', 'sentence', meta.slice(0, 4),
      '正文残留生成提示或写作元数据', '删除元数据，不改写故事正文'
    ))
  }

  if (options.finalBeat) {
    const opening = trimmed.slice(0, Math.floor(trimmed.length * 0.82))
    const ending = trimmed.slice(Math.floor(trimmed.length * 0.82))
    const arcPatterns = [
      /联姻|未婚夫|退婚|相亲/,
      /新的任务|下一个任务|下一场(?:战争|复仇|游戏)/,
      /以后.*(?:见面|接手家族|继承家业)/
    ]
    for (const pattern of arcPatterns) {
      const evidence = ending.match(pattern)?.[0]
      if (evidence && !pattern.test(opening)) {
        push(issue(
          'FINAL_NEW_ARC', 'beat', [evidence],
          '最终拍结尾突然开启未在本拍前段铺垫的新主线',
          '删除续集式任务，只保留既有主线闭环后的情绪余味'
        ))
        break
      }
    }
  }
  return issues
}

/**
 * 在故事发动机冻结前执行的确定性语义预检。只拦截证据非常明确的冲突，
 * 其余复杂问题交给窄问题语义审计，避免关键词门禁误伤正常题材。
 */
export function detectStorySettingContradictions(
  source: string,
  /**
   * 本轮候选给出的权威消歧。发动机审计时必须只传 candidate 的
   * setting_resolutions，避免旧设定里一句含糊的自我辩解误放行。
   */
  resolutionSource = source
): StoryHarnessIssue[] {
  const signals = inspectStorySettingSignals(source)
  const resolution = resolutionSource.replace(/\s+/g, '')
  const issues: StoryHarnessIssue[] = []
  const legacyBridge = /母亲(?:去世|离世)后.{0,24}(?:认回|找到|继承)|后来才.{0,12}(?:认回|继承)|与家族断绝关系|资产冻结|信托.{0,10}解锁/.test(resolution)
  const welfareEnded = /(?:退出|停止|停掉|终止|注销).{0,12}(?:低保|贫困补助|特困补助)|(?:低保|贫困补助|特困补助).{0,12}(?:退出|停止|停掉|终止|注销)/.test(resolution)
  const wealthAcquiredLater = /(?:之后|此后|后来|随后|才).{0,16}(?:认回|继承|取得|获得).{0,12}(?:家族|财团|资产|财产)|(?:认回|继承|取得|获得).{0,12}(?:家族|财团|资产|财产).{0,12}(?:发生在|晚于|在.{0,8}之后)/.test(resolution)
  const bridge = hasTaggedStoryResolution(resolutionSource, 'POVERTY_WEALTH_CONFLICT')
    || legacyBridge
    || (welfareEnded && wealthAcquiredLater)
    || /福利退出早于财富取得/.test(resolution)
  if (signals.povertyWealthConflict && !bridge) {
    issues.push(issue(
      'POVERTY_WEALTH_CONFLICT', 'engine',
      ['同时存在低保/贫困补助、豪门继承人和可自由支配的巨额捐赠'],
      '主角的贫困资格与可支配财富处于同一时期，破坏人物合法性',
      '在 setting_resolutions 中明确福利退出早于财富取得，或删除其中一套互斥设定'
    ))
  }

  const relativeRecused = /(?:爷爷|祖父|亲属|直系亲属).{0,36}(?:(?:回避|不参与|未参与|退出).{0,16}(?:命题|评审|评分|成绩认定|复核)|(?:命题|评审|评分|成绩认定|复核).{0,16}(?:强制)?(?:回避|不参与|未参与|退出))|(?:命题|评审|评分|成绩认定|复核).{0,12}(?:回避|不参与|未参与).{0,16}(?:爷爷|祖父|亲属|直系亲属)/.test(resolution)
  const independentAdjudication = /(?:无利益关系|独立|省级|国家级).{0,18}(?:机构|组委会|奥赛委|专家组).{0,18}(?:出具|评审|评分|认定|复核)|(?:成绩|试卷).{0,18}(?:由|经).{0,12}(?:无利益关系|独立|省级|国家级).{0,18}(?:机构|组委会|奥赛委|专家组)/.test(resolution)
  const adjudicatorResolved = hasTaggedStoryResolution(resolutionSource, 'ADJUDICATOR_CONFLICT_OF_INTEREST')
    || (relativeRecused && independentAdjudication)
  if (signals.adjudicatorConflict && !adjudicatorResolved) {
    issues.push(issue(
      'ADJUDICATOR_CONFLICT_OF_INTEREST', 'engine',
      ['主角直系亲属参与竞赛组织或评审，同时主角依靠该竞赛结果证明公平'],
      '核心胜利存在无法回避的利益冲突',
      '在 setting_resolutions 中同时明确亲属强制回避、成绩由无利益关系的独立机构认定，或移除亲属竞赛职务'
    ))
  }

  const canonicalDeadline = resolution.match(/(?:统一|唯一|最终|一律)(?:的)?公示期(?:还|只)?剩?(\d{1,3})天(?:为准)?|公示期(?:统一|最终|一律)?(?:还|只)?剩?(\d{1,3})天(?:为准|作为唯一口径)/)
  const deadlineResolved = hasTaggedStoryResolution(resolutionSource, 'DEADLINE_CONTRADICTION')
    || Boolean(canonicalDeadline)
  if (new Set(signals.deadlineValues).size > 1 && !deadlineResolved) {
    issues.push(issue(
      'DEADLINE_CONTRADICTION', 'engine',
      [`公示期剩余天数出现多个值：${[...new Set(signals.deadlineValues)].join('、')}`],
      '核心倒计时在设定阶段已经自相矛盾',
      '在 setting_resolutions 中声明唯一公示期剩余天数，并在后续合同中以该值为准'
    ))
  }
  return issues
}

/** 少量套话是软问题，达到密度或数量阈值才阻断发布。 */
export function shouldBlockStoryAntiAi(violationCount: number, bodyChars: number): boolean {
  if (violationCount <= 0) return false
  const normalizedChars = Math.max(1, bodyChars)
  return violationCount >= 5 || violationCount / normalizedChars > 1 / 1200
}

export interface StoryHarnessBudgetState {
  issueAttempts: number
  candidatesForBeat: number
  wholeAudits: number
}

export function storyHarnessBudgetBlockers(
  state: StoryHarnessBudgetState,
  profile: StoryModelCapabilityProfile
): string[] {
  const blockers: string[] = []
  if (state.issueAttempts >= profile.maxIssueRepairs) blockers.push('同一问题已达到修复上限')
  if (state.candidatesForBeat >= STORY_HARNESS_MAX_CANDIDATES_PER_BEAT) blockers.push('当前节拍候选已达到上限')
  if (state.wholeAudits >= profile.maxWholeAudits) blockers.push('整篇审计已达到上限')
  return blockers
}
