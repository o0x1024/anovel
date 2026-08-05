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
  /** 同码同章内具体因果故障的稳定标识，例如 LIU_PROFESSOR_UNSEEDED_INTERVENTION。 */
  identityHint?: string
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

export interface DeterministicStorySentenceRepair {
  content: string
  repairs: Array<{ before: string; after: string }>
}

export interface DeterministicStoryCandidateRepair {
  content: string
  quoteChanged: boolean
  sentenceRepairs: Array<{ before: string; after: string }>
  repairCount: number
}

/**
 * 原位修复已知、无歧义的坏词片段。只允许替换命中的短片段，不能借机重写句子。
 *
 * 生成模型偶尔会把“四十分钟”污染成“四挺钟”或“四颇为钟”。这两种形式
 * 的缺失部分可以由字面结构唯一恢复，因此不应消耗一次整拍重写和盲评预算。
 */
export function repairDeterministicStorySentences(text: string): DeterministicStorySentenceRepair {
  const repairs: Array<{ before: string; after: string }> = []
  const content = text.replace(
    /([一二三四五六七八九十\d]+)(挺|颇为)钟/g,
    (before: string, amount: string) => {
      const after = /^[一二三四五六七八九]$/.test(amount)
        ? `${amount}十分钟`
        : `${amount}分钟`
      repairs.push({ before, after })
      return after
    }
  )
  return { content, repairs }
}

/**
 * 候选进入任何门禁或持久化之前的唯一确定性归一化入口。
 * 这里只修复能够从原文字面唯一恢复的损坏，不允许润色、扩写或改动叙事含义。
 */
export function repairDeterministicStoryCandidate(text: string): DeterministicStoryCandidateRepair {
  const quoteRepaired = repairDeterministicStoryQuotes(text)
  const sentenceResult = repairDeterministicStorySentences(quoteRepaired)
  const quoteChanged = quoteRepaired !== text
  return {
    content: sentenceResult.content,
    quoteChanged,
    sentenceRepairs: sentenceResult.repairs,
    repairCount: sentenceResult.repairs.length + (quoteChanged ? 1 : 0)
  }
}

const STORY_HOUR_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12
}

function parseStoryHour(value: string): number | null {
  if (/^\d{1,2}$/.test(value)) {
    const parsed = Number(value)
    return parsed >= 0 && parsed <= 24 ? parsed : null
  }
  return STORY_HOUR_DIGITS[value] ?? null
}

function normalizeStoryClockHour(period: string, hour: number): number {
  if (period === '下午' || period === '晚上') return hour < 12 ? hour + 12 : hour
  if (period === '凌晨') return hour === 12 ? 0 : hour
  if (period === '上午') return hour === 12 ? 0 : hour
  return hour
}

/** 检出同一句中可以确定计算的“起始时刻 + N 小时 = 截止时刻”矛盾。 */
export function detectStoryDeadlineArithmeticIssues(
  text: string,
  chapterId?: number
): StoryHarnessIssue[] {
  const issues: StoryHarnessIssue[] = []
  const pattern = /(?:现在|当前)?(?:是)?(凌晨|上午|下午|晚上)([零一二两三四五六七八九十\d]{1,3})点[\s\S]{0,48}?([一二两三四五六七八九十\d]{1,3})个?小时后(?:就|将)?是?(凌晨|上午|下午|晚上)([零一二两三四五六七八九十\d]{1,3})点/g
  for (const match of text.matchAll(pattern)) {
    const start = parseStoryHour(match[2])
    const duration = parseStoryHour(match[3])
    const stated = parseStoryHour(match[5])
    if (start == null || duration == null || stated == null) continue
    const expected = (normalizeStoryClockHour(match[1], start) + duration) % 24
    const actual = normalizeStoryClockHour(match[4], stated) % 24
    if (expected === actual) continue
    const expectedLabel = expected === 0
      ? '凌晨十二点'
      : expected < 12
        ? `上午${expected}点`
        : expected === 12
          ? '中午十二点'
          : `晚上${expected - 12}点`
    issues.push({
      code: 'DEADLINE_ARITHMETIC_CONTRADICTION',
      severity: 'blocker',
      scope: 'sentence',
      chapterIds: chapterId == null ? undefined : [chapterId],
      evidence: [match[0]],
      message: `倒计时时间计算错误：所写截止时刻与起始时刻加 ${duration} 小时不一致`,
      expectedResult: `只修正截止时刻或时长，使结果明确等于${expectedLabel}`
    })
  }
  return issues
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
  // scope 是评估器给出的修复建议，不是问题身份。同一条时间线硬伤可能在
  // 两次独立审计中分别被标成 engine/cluster；把 scope 放进 key 会让旧问题
  // 被误判为已解决，同时创建一条“新”问题。
  const identity = value.identityHint?.trim().toUpperCase().replace(/[^A-Z0-9_\-\u4e00-\u9fff]+/g, '_')
  return identity ? `${value.code}:${chapters}:${identity.slice(0, 120)}` : `${value.code}:${chapters}`
}

export function stableStoryHash(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

/**
 * 熔断身份必须绑定具体候选与具体证据。不同正文即使触发同类门禁，也不是同一次失败。
 */
export function storyCandidateDefectSignature(
  chapterId: number,
  content: string,
  issues: StoryHarnessIssue[]
): string {
  const evidenceIdentity = issues
    .map(item => `${item.code}:${stableStoryHash(item.evidence.join('\n'))}`)
    .sort()
    .join('|')
  return [
    'BODY_TEXT_INTEGRITY',
    `chapter:${chapterId}`,
    `candidate:${stableStoryHash(content)}`,
    `evidence:${stableStoryHash(evidenceIdentity)}`
  ].join(':')
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** 不依赖模型的成稿完整性检查。 */
export function detectStoryTextIntegrityIssues(
  text: string,
  options: {
    chapterId?: number
    finalBeat?: boolean
    povMode?: string | null
    povCharacter?: string | null
  } = {}
): StoryHarnessIssue[] {
  const issues: StoryHarnessIssue[] = []
  const chapterIds = options.chapterId == null ? undefined : [options.chapterId]
  const push = (value: StoryHarnessIssue) => issues.push({ ...value, chapterIds })
  const trimmed = text.trim()
  if (!trimmed) {
    push(issue('EMPTY_BODY', 'beat', ['正文为空'], '节拍正文为空，禁止提交正式章节', '生成非空且完整的正文'))
    return issues
  }

  issues.push(...detectStoryDeadlineArithmeticIssues(trimmed, options.chapterId))

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

  const corrupted = nonEmptyLines(trimmed).filter(line =>
    /(?:[一二三四五六七八九十\d]+挺钟|[一二三四五六七八九十\d]+颇为钟)/.test(line)
    || /只要[^。！？\n]{0,40}(?:揭穿|证明|告诉|拿出|查清|逼迫)$/.test(line)
  )
  if (corrupted.length > 0) {
    push(issue(
      'CORRUPTED_SENTENCE', 'sentence', corrupted.slice(0, 4),
      '正文存在明显错词或未完成的承重句', '只修复对应句子的错词或缺失成分，不改变剧情事实'
    ))
  }

  const povMode = options.povMode?.trim()
  const povCharacter = options.povCharacter?.trim()
  if (povMode && trimmed.length >= 400) {
    // 对话中的“我”不代表叙事视角；只统计引号外的叙述文本。
    const narration = trimmed.replace(/“[^”]*”/g, '')
    const firstPersonCount = (narration.match(/我(?:们|的|在|要|想|看|听|说|没|不|把|从|向|又|也|就|才|已经|仍|正|刚)?/g) ?? []).length
    const characterCount = povCharacter
      ? (narration.match(new RegExp(povCharacter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      : 0
    if (povMode === 'first' && povCharacter && characterCount >= 3 && firstPersonCount <= 1) {
      push(issue(
        'POV_DRIFT', 'beat', [`叙述段中“${povCharacter}”出现 ${characterCount} 次，“我”仅 ${firstPersonCount} 次`],
        '第一人称故事在本拍漂移为第三人称叙述', '保持事件不变，将叙述恢复为冻结的第一人称视角'
      ))
    }
    if (povMode === 'third_limited' && firstPersonCount >= 6) {
      push(issue(
        'POV_DRIFT', 'beat', [`引号外第一人称叙述信号出现 ${firstPersonCount} 次`],
        '第三人称限知故事在本拍漂移为第一人称叙述', '保持事件不变，将叙述恢复为冻结的第三人称限知视角'
      ))
    }
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
