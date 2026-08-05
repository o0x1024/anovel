import { createHash } from 'node:crypto'
import {
  goalRoutineDAO,
  resourceLedgerDAO,
  volumeChapterDAO,
  type ChapterResourceBudgetInput,
  type ChapterPatternFingerprintRow
} from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { detectChapterPatternIssues } from './novel-systemic-gate'
import { requestStructuredModelOutput } from './structured-model-output'
import { withGoalLoopModelOptions } from './story-goal-model'
import {
  NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
  NOVEL_VOLUME_GATE_HARD_ISSUE_CODES,
  NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS,
  NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER,
  NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE,
  NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER,
  NOVEL_VOLUME_GATE_REPAIR_FIELDS,
  NOVEL_VOLUME_GATE_REPAIR_SCHEMA,
  NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION,
  NovelPipelineError,
  intField,
  parseObject,
  readNovelGoalState,
  textField,
  updateNovelGoalState,
  planNovelVolumeGateWindows,
  type NovelVolumeContract,
  type NovelVolumeGateAssessment,
  type NovelVolumeGateCheckpoint,
  type NovelVolumeGateIssue,
  type NovelVolumeGateRepairControl,
  type NovelVolumeRange
} from './novel-volume-planning'

type VolumeGateChapter = ReturnType<typeof volumeChapterDAO.listChapters>[number]

export function novelVolumeGateIssueFingerprint(issues: NovelVolumeGateIssue[]): string {
  const normalized = issues.map(issue => ({
    code: issue.code,
    repairChapterNumbers: [...new Set(issue.repairChapterNumbers)].sort((a, b) => a - b),
    evidence: issue.evidence
      .map(item => ({ chapterNumber: item.chapterNumber, quote: item.quote }))
      .sort((a, b) => a.chapterNumber - b.chapterNumber || a.quote.localeCompare(b.quote)),
    problem: issue.problem,
    requiredFix: issue.requiredFix
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function volumeGateSnapshotFingerprint(chapters: VolumeGateChapter[]): string {
  const hash = createHash('sha256')
  for (const chapter of chapters) {
    hash.update(JSON.stringify({
      id: chapter.id,
      update_time: chapter.update_time,
      status: chapter.status,
      content_hash: createHash('sha256').update(chapter.content ?? '').digest('hex'),
      title: chapter.title,
      outline: chapter.outline,
      beat_role: chapter.beat_role,
      foreshadow_target: chapter.foreshadow_target,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      outline_diagnosis: chapter.outline_diagnosis,
      emotion_contract_json: chapter.emotion_contract_json
    }))
  }
  return hash.digest('hex')
}

function volumeGateWindowFingerprint(input: {
  chapters: VolumeGateChapter[]
  contractStartChapter: number
  range: NovelVolumeRange
}): string {
  const firstIndex = Math.max(0, input.range.startChapter - input.contractStartChapter - 1)
  const lastIndex = Math.min(
    input.chapters.length - 1,
    input.range.endChapter - input.contractStartChapter + 1
  )
  return volumeGateSnapshotFingerprint(input.chapters.slice(firstIndex, lastIndex + 1))
}

export function checkNovelVolumeRepairBudget(input: {
  chapterNumbers: number[]
  control?: NovelVolumeGateRepairControl
}): { allowed: boolean; control: NovelVolumeGateRepairControl; reason?: string } {
  const chapterNumbers = [...new Set(input.chapterNumbers)].sort((a, b) => a - b)
  const current = input.control ?? {
    changedChapterNumbers: [],
    rewriteCounts: {},
    lastRoundVersions: []
  }
  const activeWave = current.waveChapterNumbers
    ?? (current.completedWaveCount == null ? current.changedChapterNumbers : [])
  const changed = new Set(activeWave)
  for (const chapterNumber of chapterNumbers) changed.add(chapterNumber)
  if (changed.size > NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS) {
    return {
      allowed: false,
      control: current,
      reason: `整卷自动修复将触及 ${changed.size} 章，超过安全上限 ${NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS} 章`
    }
  }
  for (const chapterNumber of chapterNumbers) {
    const count = current.rewriteCounts[String(chapterNumber)] ?? 0
    if (count >= NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER) {
      return {
        allowed: false,
        control: current,
        reason: `第 ${chapterNumber} 章已自动修复 ${count} 次，禁止再次改写`
      }
    }
  }
  return {
    allowed: true,
    control: {
      ...current,
      changedChapterNumbers: [...new Set([...current.changedChapterNumbers, ...changed])].sort((a, b) => a - b),
      waveChapterNumbers: [...changed].sort((a, b) => a - b)
    }
  }
}

function clampGateScore(value: unknown): number {
  const score = Number(value)
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0
}

function compactGateText(value: string | null | undefined, maxChars: number): string {
  const text = String(value ?? '').trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

function parseChapterDiagnosis(chapter: VolumeGateChapter): Record<string, unknown> {
  try {
    const parsed = JSON.parse(chapter.outline_diagnosis ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节「${chapter.title}」的结构合同不是合法 JSON`)
  }
}

function compactGateContractFields(value: unknown, keys: string[], maxChars: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  return Object.fromEntries(keys.map(key => [key, compactGateText(String(row[key] ?? ''), maxChars)]))
}

function compactChapterForVolumeGate(chapter: VolumeGateChapter, chapterNumber: number): Record<string, unknown> {
  const diagnosis = parseChapterDiagnosis(chapter)
  const tension = diagnosis.tension_plan && typeof diagnosis.tension_plan === 'object' && !Array.isArray(diagnosis.tension_plan)
    ? diagnosis.tension_plan as Record<string, unknown>
    : {}
  return {
    chapterNumber,
    title: chapter.title,
    status: chapter.status,
    // Window diagnosis only needs state-bearing excerpts; sending full chapter
    // bodies makes structured output truncation inevitable on long windows.
    content: compactGateText(chapter.content, 1400),
    outline: compactGateText(chapter.outline, 1000),
    beat_role: chapter.beat_role,
    foreshadow_target: compactGateText(chapter.foreshadow_target, 160),
    next_hook: compactGateText(chapter.next_hook, 240),
    dramatic_contract: compactGateContractFields(diagnosis.dramatic_contract, [
      'scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'turn',
      'irreversible_change', 'payoff_or_debt', 'next_question'
    ], 160),
    pattern_contract: compactGateContractFields(diagnosis.pattern_contract, [
      'conflict_type', 'protagonist_method', 'antagonist_tactic', 'anticipated_opponent_adjustment',
      'location_type', 'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
    ], 120),
    tension_plan: {
      level: tension.level ?? '',
      payoff_type: tension.payoff_type ?? ''
    }
  }
}

function compactGateEvidence(value: string): string {
  return value.replace(/[\s“”‘’'"《》【】]/g, '')
}

/**
 * 弱模型偶尔会用省略号把同一章的多段原文拼成一条证据。
 * 先保留严格的连续子串匹配；只在存在显式省略号时拆分，并要求每个片段都在同一章输入中逐字命中。
 * 这是格式容错，不是语义模糊匹配：任一片段对不上仍然整条拒绝。
 */
export function locateNovelVolumeGateEvidenceFragments(source: string, quote: string): string[] {
  const normalizedSource = compactGateEvidence(source)
  const normalizedQuote = compactGateEvidence(quote)
  if (normalizedQuote.length >= 4 && normalizedSource.includes(normalizedQuote)) {
    return [quote.trim()]
  }

  if (!/(?:…{1,}|\.{3,})/u.test(quote)) return []
  const fragments = quote
    .split(/(?:…{1,}|\.{3,})/u)
    .map(fragment => fragment.trim())
    .filter(Boolean)
  if (fragments.length < 2 || fragments.length > 4) return []
  if (fragments.some(fragment => {
    const normalized = compactGateEvidence(fragment)
    return normalized.length < 4 || !normalizedSource.includes(normalized)
  })) return []
  return fragments
}

function chapterGateEvidence(chapter: VolumeGateChapter, chapterNumber: number): string {
  return compactGateEvidence(JSON.stringify(compactChapterForVolumeGate(chapter, chapterNumber)))
}

function normalizeVolumeGateIssueCode(value: unknown): string {
  const normalized = String(value ?? 'SEMANTIC_CONTRACT_ISSUE')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64)
  return normalized || 'SEMANTIC_CONTRACT_ISSUE'
}

/**
 * 硬门禁只接受输入中可直接互斥的事实。单纯没有再次说明、没有显式关联，
 * 或连续章节重复描述同一状态，都属于写作建议，不能触发自动改写。
 */
export function isActionableNovelVolumeGateIssue(input: {
  code: string
  problem: string
  requiredFix: string
  evidenceChapterNumbers: number[]
}): boolean {
  const evidenceChapters = new Set(input.evidenceChapterNumbers)
  if (evidenceChapters.size < 2 && /CONTINUITY_BREAK|SETUP_PAYOFF_MISMATCH/.test(input.code)) return false
  const text = `${input.problem}\n${input.requiredFix}`
  return !(
    /未提及|未交代|没有(?:提及|交代|明确说明)|未明确(?:说明|是同一|关联|来源)|未对.{0,40}(?:解释|衔接)/.test(text)
    || /重复描述.{0,30}(?:状态断层|资源状态断层|连续性断层)/.test(text)
    || /明确.{0,30}(?:是同一|延续|关联|来源).{0,20}(?:避免|防止)/.test(text)
    || /角色与环境关联.{0,20}断层/.test(text)
  )
}

export function shouldBlockNovelVolumeGateIssues(input: {
  score: number
  issues: NovelVolumeGateIssue[]
  deterministicIssueCount: number
}): boolean {
  // 进入本函数的 issue 已经通过逐字证据定位和硬问题码过滤。
  // 任何一项未清零都意味着该卷不能成为后续章节的冻结事实。
  return input.issues.length > 0
}

function boundedRepairCandidates(candidates: number[]): number[] {
  const unique = [...new Set(candidates)].sort((a, b) => a - b)
  // 跨章问题过大时优先修改后出现的合同，保留较早章节作为只读事实锚点。
  return unique.slice(-NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE)
}

export function selectNovelVolumeGateRepairTargets(input: {
  repairCandidates?: number[]
  evidenceChapterNumbers: number[]
  editableChapterNumbers: number[]
}): number[] {
  const editable = new Set(input.editableChapterNumbers)
  const candidates = input.repairCandidates?.length
    ? input.repairCandidates
    : input.evidenceChapterNumbers.filter(number => editable.has(number))
  return boundedRepairCandidates(candidates.filter(number => editable.has(number)))
}

function parseModelVolumeGateIssues(input: {
  value: unknown
  label: string
  allowedEvidenceChapterNumbers: Set<number>
  editableChapterNumbers: Set<number>
  chaptersByNumber: Map<number, VolumeGateChapter>
}): NovelVolumeGateIssue[] {
  if (!Array.isArray(input.value)) {
    throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}缺少 issues 数组`)
  }
  return input.value.flatMap((value, issueIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}第 ${issueIndex + 1} 个问题不是对象`)
    }
    const row = value as Record<string, unknown>
    const code = normalizeVolumeGateIssueCode(row.code)
    const declaredSeverity = String(row.severity ?? 'hard').trim().toLowerCase()
    const severity: 'hard' | 'advisory' = declaredSeverity === 'hard'
      && NOVEL_VOLUME_GATE_HARD_ISSUE_CODES.has(code)
      ? 'hard'
      : 'advisory'
    const problem = textField(row, 'problem', `${input.label}第 ${issueIndex + 1} 个问题`)
    const requiredFix = String(row.requiredOutcome ?? row.requiredFix ?? '').trim()
    if (!requiredFix) throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」缺少 requiredOutcome`)
    // 建议性问题只保留在模型 summary，不允许进入自动修复链。
    if (severity === 'advisory') return []
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」没有逐字证据`)
    }
    let evidence: Array<{ chapterNumber: number; quote: string }>
    try {
      evidence = row.evidence.flatMap((rawEvidence, evidenceIndex) => {
        if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」第 ${evidenceIndex + 1} 条证据不是对象`)
        }
        const evidenceRow = rawEvidence as Record<string, unknown>
        const chapterNumber = intField(evidenceRow, 'chapterNumber', `${input.label}问题「${problem}」证据`)
        const quote = textField(evidenceRow, 'quote', `${input.label}问题「${problem}」证据`)
        const chapter = input.chaptersByNumber.get(chapterNumber)
        if (!input.allowedEvidenceChapterNumbers.has(chapterNumber) || !chapter) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」引用了证据范围外的第 ${chapterNumber} 章`)
        }
        const fragments = locateNovelVolumeGateEvidenceFragments(
          chapterGateEvidence(chapter, chapterNumber),
          quote
        )
        if (fragments.length === 0) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」的第 ${chapterNumber} 章证据无法在输入合同中逐字定位`)
        }
        return fragments.map(fragment => ({ chapterNumber, quote: fragment }))
      })
    } catch (error) {
      // 弱模型的证据格式偏差不是小说合同错误：没有可定位证据就忽略该问题，不进入目标轮次重试。
      if (error instanceof NovelPipelineError && error.code === 'OUTPUT_INVALID') return []
      throw error
    }

    const rawCandidates = Array.isArray(row.repairCandidates)
      ? row.repairCandidates
      : Array.isArray(row.chapterNumbers)
        ? row.chapterNumbers // 兼容升级前的已返回结果和旧模型格式。
        : undefined
    const candidateNumbers = rawCandidates
      ? rawCandidates.map(Number)
      : evidence.map(item => item.chapterNumber).filter(number => input.editableChapterNumbers.has(number))
    if (candidateNumbers.some(number => !Number.isInteger(number) || !input.editableChapterNumbers.has(number))) {
      return []
    }
    const repairChapterNumbers = selectNovelVolumeGateRepairTargets({
      repairCandidates: candidateNumbers,
      evidenceChapterNumbers: evidence.map(item => item.chapterNumber),
      editableChapterNumbers: [...input.editableChapterNumbers]
    })
    if (repairChapterNumbers.length === 0) {
      return []
    }
    if (!isActionableNovelVolumeGateIssue({
      code,
      problem,
      requiredFix,
      evidenceChapterNumbers: evidence.map(item => item.chapterNumber)
    })) {
      return []
    }
    return [{ source: 'model', severity, code, problem, repairChapterNumbers, evidence, requiredFix }]
  })
}

function parseVolumeGateAssessment(input: {
  content: string
  label: string
  key: string
  startChapter: number
  endChapter: number
  allowedEvidenceChapterNumbers: Set<number>
  editableChapterNumbers: Set<number>
  chaptersByNumber: Map<number, VolumeGateChapter>
}): NovelVolumeGateAssessment {
  const parsed = parseObject(input.content, input.label)
  const issues = parseModelVolumeGateIssues({
    value: parsed.issues,
    label: input.label,
    allowedEvidenceChapterNumbers: input.allowedEvidenceChapterNumbers,
    editableChapterNumbers: input.editableChapterNumbers,
    chaptersByNumber: input.chaptersByNumber
  })
  const score = clampGateScore(parsed.score)
  return {
    key: input.key,
    startChapter: input.startChapter,
    endChapter: input.endChapter,
    // 分数只用于诊断展示；弱模型的主观分数不能单独触发重写。
    passed: issues.length === 0,
    score,
    summary: compactGateText(String(parsed.summary ?? ''), 600),
    issues
  }
}

async function assessVolumeChapterWindow(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  chapters: VolumeGateChapter[]
  range: NovelVolumeRange
  signal?: AbortSignal
}): Promise<NovelVolumeGateAssessment> {
  const chaptersByNumber = new Map(input.chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const targetNumbers = Array.from(
    { length: input.range.endChapter - input.range.startChapter + 1 },
    (_, index) => input.range.startChapter + index
  )
  const contextNumbers = [input.range.startChapter - 1, input.range.endChapter + 1]
    .filter(number => chaptersByNumber.has(number))
  const key = `${input.range.startChapter}-${input.range.endChapter}`
  const assessment = await requestStructuredModelOutput<NovelVolumeGateAssessment>({
    workId: input.workId,
    label: `分卷「${input.contract.name}」第 ${key} 章窗口门禁`,
    attempts: 4,
    signal: input.signal,
    schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_volume_chapter_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: [2400, 3200, 4800, 6400][Math.min(attempt - 1, 3)],
      responseSchema: {
        name: 'novel_volume_chapter_gate_assessment',
        schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
        strict: true
      },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是长篇小说章节合同门禁。只读评估，不得输出修复后的章节，只输出合法 JSON。',
        '只检查当前窗口：因果链、冲突升级、阶段目标推进、角色选择与代价、伏笔、功能重复、节奏断层，以及与相邻章的接口。',
        '本卷合同用于判断方向，但不得因为个人文风偏好或没有证据的猜测压低分数。',
        'severity=hard 只用于两段输入中已经同时存在、可直接互斥的状态事实；“可能误解、执行时可能出错、节奏可优化、存在风险”一律是 advisory，只写入 summary，不得放入 issues。',
        '没有再次提及尸体、毒伤、资源消耗或环境线索，不等于状态断裂；连续章节重复描述同一次受伤、净化或事件，是状态延续，不是互斥事实。',
        '累计推进不能误判为数量矛盾：前章完成第一项、后章继续第二项/第三项属于正常递进。problem 中的每个事实必须与 evidence.quote 字面一致。',
        `hard code 仅允许：${[...NOVEL_VOLUME_GATE_HARD_ISSUE_CODES].join('、')}；功能重复、节奏、文风与信息密度不得触发自动修复。`,
        'evidence 可引用当前窗口或相邻只读上下文；每条 quote 只摘录一段 4-80 字的连续原文，必须逐字摘自输入中的 title、outline、next_hook 或结构合同。',
        '禁止在 quote 中改写、概括，或用“……”拼接两段原文；需要两段证据时必须输出两个 evidence 项。',
        'repairCandidates 只列当前窗口内真正可能需要修改的章节，不得包含相邻只读章节；可以超过2章，程序会按最小安全簇拆分。',
        '只报告阻断问题；没有逐字证据不得列问题或压低分数。passed 由程序根据证据计算，不要输出。',
        '输出必须极简：最多 4 个 issues；problem 不超过 240 字，requiredOutcome 不超过 240 字，summary 不超过 180 字。只保留最硬的状态互斥问题。',
        '格式：{"score":88,"issues":[{"severity":"hard","code":"STATE_CONTINUITY_BREAK","problem":"","repairCandidates":[2,3],"evidence":[{"chapterNumber":1,"quote":"输入中的逐字短句"}],"requiredOutcome":""}],"summary":"窗口结论"}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
        `【本卷合同】\n${JSON.stringify(input.contract)}`,
        `【当前窗口 ${key}】\n${JSON.stringify(targetNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`,
        contextNumbers.length > 0
          ? `【只读相邻上下文：可作证据，不得列入 repairCandidates】\n${JSON.stringify(contextNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
          : '',
        attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
      ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: parsed => parseVolumeGateAssessment({
      content: JSON.stringify(parsed),
      label: `分卷「${input.contract.name}」第 ${key} 章窗口门禁`,
      key,
      startChapter: input.range.startChapter,
      endChapter: input.range.endChapter,
      allowedEvidenceChapterNumbers: new Set([...targetNumbers, ...contextNumbers]),
      editableChapterNumbers: new Set(targetNumbers),
      chaptersByNumber
    })
  })
  return {
    ...assessment,
    inputFingerprint: volumeGateWindowFingerprint({
      chapters: input.chapters,
      contractStartChapter: input.contract.startChapter,
      range: input.range
    })
  }
}

function volumeGateAnchorNumbers(contract: NovelVolumeContract): number[] {
  const midpoint = Math.floor((contract.startChapter + contract.endChapter) / 2)
  return [...new Set([
    contract.startChapter,
    contract.startChapter + 1,
    midpoint - 1,
    midpoint,
    midpoint + 1,
    contract.endChapter - 2,
    contract.endChapter - 1,
    contract.endChapter
  ].filter(number => number >= contract.startChapter && number <= contract.endChapter))]
}

async function assessVolumeChapterAggregate(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  chapters: VolumeGateChapter[]
  assessments: NovelVolumeGateAssessment[]
  signal?: AbortSignal
}): Promise<NovelVolumeGateAssessment> {
  const chaptersByNumber = new Map(input.chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const anchorNumbers = volumeGateAnchorNumbers(input.contract)
  return requestStructuredModelOutput<NovelVolumeGateAssessment>({
    workId: input.workId,
    label: `分卷「${input.contract.name}」只读聚合门禁`,
    attempts: 4,
    signal: input.signal,
    schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_volume_chapter_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: [1800, 2400, 3600, 4800][Math.min(attempt - 1, 3)],
      responseSchema: {
        name: 'novel_volume_chapter_gate_aggregate',
        schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
        strict: true
      },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是长篇小说整卷章节合同聚合门禁。只读汇总，不得输出任何章节补丁，只输出合法 JSON。',
        '依据本卷合同、全部窗口报告和卷首/中点/卷末锚点，检查阶段目标、中点转折、卷高潮、不可逆代价、mustResolve 和跨卷债务是否闭环。',
        '不得推翻已经通过的窗口，除非锚点证据能证明整卷合同存在阻断缺口。',
        'severity=hard 只用于锚点中已实际存在的互斥事实；潜在风险、可选优化、节奏和文风问题只写 summary，不得进入 issues。',
        'evidence.quote 必须是逐字摘自锚点输入的 4-80 字连续原文；禁止改写、概括或用省略号拼接，多段证据必须拆成多个 evidence 项。',
        'repairCandidates 只列锚点中真正需要修改的章节，可以超过2章，由程序拆分。',
        '没有逐字证据不得列问题或压低分数。passed 由程序根据证据计算，不要输出。',
        '输出必须极简：最多 2 个 issues；problem 和 requiredOutcome 各不超过 240 字，summary 不超过 180 字。',
        '格式：{"score":88,"issues":[{"severity":"hard","code":"SETUP_PAYOFF_MISMATCH","problem":"","repairCandidates":[1],"evidence":[{"chapterNumber":1,"quote":"输入中的逐字短句"}],"requiredOutcome":""}],"summary":"整卷只读结论"}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
        `【本卷合同】\n${JSON.stringify(input.contract, null, 2)}`,
        `【全部窗口只读报告】\n${JSON.stringify(input.assessments.map(item => ({
          range: item.key,
          passed: item.passed,
          score: item.score,
          summary: item.summary
        })), null, 2)}`,
        `【卷级锚点证据】\n${JSON.stringify(anchorNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
        ,attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
      ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: parsed => parseVolumeGateAssessment({
      content: JSON.stringify(parsed),
      label: `分卷「${input.contract.name}」只读聚合门禁`,
      key: 'aggregate',
      startChapter: input.contract.startChapter,
      endChapter: input.contract.endChapter,
      allowedEvidenceChapterNumbers: new Set(anchorNumbers),
      editableChapterNumbers: new Set(anchorNumbers),
      chaptersByNumber
    })
  })
}

function plannedPatternFingerprints(workId: number, chapters: VolumeGateChapter[]): ChapterPatternFingerprintRow[] {
  return chapters.flatMap((chapter): ChapterPatternFingerprintRow[] => {
    const diagnosis = parseChapterDiagnosis(chapter) as {
      pattern_contract?: Record<string, string>
      tension_plan?: { payoff_type?: ChapterPatternFingerprintRow['payoff_type'] }
    }
    const pattern = diagnosis.pattern_contract
    if (!pattern) return []
    return [{
      chapter_id: chapter.id,
      work_id: workId,
      conflict_type: pattern.conflict_type ?? '',
      protagonist_method: pattern.protagonist_method ?? '',
      antagonist_tactic: pattern.antagonist_tactic ?? '',
      antagonist_outcome: '',
      opponent_adjustment: pattern.anticipated_opponent_adjustment ?? '',
      location_type: pattern.location_type ?? '',
      hook_type: pattern.hook_type ?? '',
      cost_type: pattern.cost_type ?? '',
      relationship_delta: pattern.relationship_delta ?? '',
      volume_objective_delta: pattern.volume_objective_delta ?? '',
      payoff_type: diagnosis.tension_plan?.payoff_type ?? 'debt',
      create_time: '',
      update_time: ''
    }]
  })
}

function deterministicVolumeGateIssues(
  workId: number,
  contract: NovelVolumeContract,
  chapters: VolumeGateChapter[]
): NovelVolumeGateIssue[] {
  const numberById = new Map(chapters.map((chapter, index) => [chapter.id, contract.startChapter + index]))
  return detectChapterPatternIssues(chapters, plannedPatternFingerprints(workId, chapters), {
    requireFingerprints: true,
    includeProseScan: true
  }).filter(issue => issue.severity === 'blocker').flatMap(issue => {
    const affected = [...new Set(issue.chapterIds.map(id => numberById.get(id)).filter((value): value is number => value != null))]
    if (affected.length === 0) return []
    const chapterNumbers = selectDeterministicNovelRepairChapterNumbers(issue.code, affected)
    return [{
      source: 'deterministic' as const,
      code: issue.code,
      problem: `${issue.code}：${issue.message}`,
      repairChapterNumbers: chapterNumbers,
      evidence: issue.evidence.slice(0, 4).map((quote, index) => ({
        chapterNumber: chapterNumbers[Math.min(index, chapterNumbers.length - 1)],
        quote
      })),
      requiredFix: issue.recommendedAction
    }]
  })
}

/** 确定性问题只选择消除门禁所需的最小章节集合。 */
export function selectDeterministicNovelRepairChapterNumbers(code: string, affected: number[]): number[] {
  const unique = [...new Set(affected)]
  if (code === 'PAYOFF_DEBT_STREAK') return unique.slice(-1)
  return unique.slice(-NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER)
}

export function planNovelVolumeGateRepairClusters(
  issues: NovelVolumeGateIssue[],
  control?: NovelVolumeGateRepairControl,
  availableChapterNumbers?: number[]
): Array<{
  chapterNumbers: number[]
  issues: NovelVolumeGateIssue[]
}>
export function planNovelVolumeGateRepairClusters(
  issues: NovelVolumeGateIssue[],
  control?: NovelVolumeGateRepairControl,
  availableChapterNumbers: number[] = []
): Array<{ chapterNumbers: number[]; issues: NovelVolumeGateIssue[] }> {
  const rootIssues = issues.flatMap(issue => {
    const preferredCandidates = [...new Set(issue.repairChapterNumbers)].sort((a, b) => a - b)
    const evidenceCandidates = issue.evidence
      .map(item => item.chapterNumber)
      .filter(chapterNumber => Number.isInteger(chapterNumber) && chapterNumber > 0)
    const directCandidates = [...new Set([...preferredCandidates, ...evidenceCandidates])].sort((a, b) => a - b)
    const available = new Set(availableChapterNumbers)
    const neighborCandidates: number[] = []
    if (available.size > 0) {
      const lower = directCandidates[0]
      const upper = directCandidates.at(-1)
      for (let distance = 1; distance <= available.size; distance++) {
        if (upper != null && available.has(upper + distance)) neighborCandidates.push(upper + distance)
        if (lower != null && available.has(lower - distance)) neighborCandidates.push(lower - distance)
        if (neighborCandidates.some(chapterNumber =>
          (control?.rewriteCounts[String(chapterNumber)] ?? 0) < NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER
        )) break
      }
    }
    const candidates = [...new Set([...directCandidates, ...neighborCandidates])].sort((a, b) => a - b)
    const writablePreferred = preferredCandidates.filter(chapterNumber =>
      (control?.rewriteCounts[String(chapterNumber)] ?? 0) < NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER
    )
    const writable = candidates.filter(chapterNumber =>
      (control?.rewriteCounts[String(chapterNumber)] ?? 0) < NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER
    )
    const writableDirect = directCandidates.filter(chapterNumber =>
      (control?.rewriteCounts[String(chapterNumber)] ?? 0) < NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER
    )
    const writableNeighbors = neighborCandidates.filter(chapterNumber =>
      (control?.rewriteCounts[String(chapterNumber)] ?? 0) < NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER
    )
    // Prefer the earliest candidate while it is writable. Once its rewrite
    // budget is spent, move ownership to the next chapter in the evidence
    // chain so a cross-chapter issue remains repairable.
    const root = (writablePreferred[0] ?? writableDirect[0] ?? writableNeighbors[0] ?? writable[0] ?? candidates[0])
    return root == null ? [] : [{ ...issue, repairChapterNumbers: [root] }]
  })
  const targets = [...new Set(rootIssues.flatMap(issue => issue.repairChapterNumbers))].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const target of targets) {
    const current = groups.at(-1)
    if (current && current.length < NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER && target === current.at(-1)! + 1) {
      current.push(target)
    } else {
      groups.push([target])
    }
  }
  return groups.map(chapterNumbers => ({
    chapterNumbers,
    issues: rootIssues.filter(issue => issue.repairChapterNumbers.some(number => chapterNumbers.includes(number)))
  }))
}

export function selectNovelVolumeRepairWave(
  clusters: Array<{ chapterNumbers: number[]; issues: NovelVolumeGateIssue[] }>,
  startIndex = 0,
  persistedWaveChapterNumbers: number[] = []
): Array<{ chapterNumbers: number[]; issues: NovelVolumeGateIssue[] }> {
  const wave: Array<{ chapterNumbers: number[]; issues: NovelVolumeGateIssue[] }> = []
  const persistedWave = new Set(persistedWaveChapterNumbers)
  // A failed repair can be resumed in the middle of an already admitted wave.
  // Re-plan only the unfinished clusters that belong to that persisted wave;
  // never append the next wave and accidentally turn 6 into 7 targets.
  if (persistedWave.size > 0) {
    for (let index = startIndex; index < clusters.length; index++) {
      const cluster = clusters[index]
      if (!cluster.chapterNumbers.every(chapterNumber => persistedWave.has(chapterNumber))) break
      wave.push(cluster)
    }
    return wave
  }
  const targets = new Set<number>()
  for (let index = startIndex; index < clusters.length; index++) {
    const cluster = clusters[index]
    const nextTargets = new Set([...targets, ...cluster.chapterNumbers])
    if (nextTargets.size > NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS) break
    wave.push(cluster)
    for (const chapterNumber of cluster.chapterNumbers) targets.add(chapterNumber)
  }
  return wave
}

type NovelVolumeGateRepairField = typeof NOVEL_VOLUME_GATE_REPAIR_FIELDS[number]

export function replaceUniqueRepairText(input: {
  chapterNumber: number
  field: NovelVolumeGateRepairField
  current: string
  oldText: string
  newText: string
}): string {
  if (input.oldText === input.newText) {
    throw new NovelPipelineError('OUTPUT_INVALID', `第 ${input.chapterNumber} 章 ${input.field} 修复前后文本相同`)
  }
  const first = input.current.indexOf(input.oldText)
  const last = input.current.lastIndexOf(input.oldText)
  if (first < 0 || first !== last) {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `第 ${input.chapterNumber} 章 ${input.field} 的 oldText 必须在当前字段中逐字且唯一命中`
    )
  }
  return `${input.current.slice(0, first)}${input.newText}${input.current.slice(first + input.oldText.length)}`
}

async function repairVolumeChapterCluster(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  volumeId: number
  chapterNumbers: number[]
  issues: NovelVolumeGateIssue[]
  retryHint?: string
  signal?: AbortSignal
}): Promise<Array<{ chapterId: number; versionId: number; chapterNumber: number }>> {
  const chapters = volumeChapterDAO.listChapters(input.volumeId)
  const chaptersByNumber = new Map(chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const targets = input.chapterNumbers.map(number => chaptersByNumber.get(number)).filter((chapter): chapter is VolumeGateChapter => !!chapter)
  if (targets.length !== input.chapterNumbers.length) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${input.contract.name}」修复目标章节不存在`)
  }
  const contextNumbers = [...new Set([
    ...input.chapterNumbers.flatMap(number => [number - 1, number + 1]),
    ...input.issues.flatMap(issue => issue.evidence.map(item => item.chapterNumber))
  ])]
    .filter(number => chaptersByNumber.has(number) && !input.chapterNumbers.includes(number))
    .sort((a, b) => a - b)
  const clusterIssues = input.issues.map(issue => ({
    ...issue,
    repairChapterNumbers: issue.repairChapterNumbers.filter(number => input.chapterNumbers.includes(number))
  }))
  const targetPayload = input.chapterNumbers.map(number => {
    const chapter = chaptersByNumber.get(number)!
    const diagnosis = parseChapterDiagnosis(chapter)
    return {
      chapterNumber: number,
      outline: chapter.outline,
      next_hook: chapter.next_hook,
      dramatic_contract: diagnosis.dramatic_contract ?? {},
      tension_plan: diagnosis.tension_plan ?? {},
      resource_budgets_read_only: resourceLedgerDAO.listBudgetsByChapter(input.workId, chapter.id)
    }
  })
  const validatedPatches = await requestStructuredModelOutput<Array<{
    chapterNumber: number
    chapter: VolumeGateChapter
    fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1]
  }>>({
    workId: input.workId,
    label: `分卷「${input.contract.name}」定点修复`,
    attempts: 2,
    signal: input.signal,
    schema: NOVEL_VOLUME_GATE_REPAIR_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        step: 'goal_novel_volume_chapter_repair',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.2,
        thinkingEnabled: false,
        forceThinkingDisabled: true,
        maxTokens: input.chapterNumbers.length === 1 ? 2400 : 4000,
        responseSchema: {
          name: 'novel_volume_chapter_minimal_repair',
          schema: NOVEL_VOLUME_GATE_REPAIR_SCHEMA,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇小说章节合同定点修复编辑。只输出合法 JSON，不要 markdown、解释或评估。',
          `只允许修改指定的 ${input.chapterNumbers.length} 个候选章节；patches 只能返回候选章节中的最小非空子集，不得改相邻章。`,
          '候选章节可能是根据证据链和改写预算重新指定的责任章节；只在候选章节内承接并消除给定问题，不要回写已耗尽预算的证据章节。',
          '只做最小文本替换：每个 operation 的 oldText 必须逐字且唯一存在于当前字段，newText 只修正点名的连续性事实。',
          `field 只允许：${NOVEL_VOLUME_GATE_REPAIR_FIELDS.join('、')}。不得重写整章，不得改标题、角色、beat_role、情绪合同、pattern_contract 或资源预算。`,
          'patches 可以只返回指定章节中的最小非空子集；不要为了凑齐章节数修改不需要改的章节。',
          '修复 PAYOFF_DEBT_STREAK 时，至少一章必须把 tension_plan.payoff_type 从 debt 改为 partial 或 major，并同步修改该章 outline 或 dramatic_contract，使阶段兑现与人物状态变化有实际剧情依据。',
          '格式：{"patches":[{"chapterNumber":1,"operations":[{"field":"outline","oldText":"当前字段中的逐字短段","newText":"修正后短段"}]}]}'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
          `【本卷合同】\n${JSON.stringify(input.contract, null, 2)}`,
          `【必须消除的问题与证据】\n${JSON.stringify(clusterIssues, null, 2)}`,
          `【只允许修改的当前章节合同】\n${JSON.stringify(targetPayload, null, 2)}`,
          contextNumbers.length > 0
            ? `【只读相邻章节】\n${JSON.stringify(contextNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
            : '',
          input.retryHint ? `【上一轮失败，必须改变策略】\n${input.retryHint}\n不要重复上一轮相同的 field、oldText 或 newText。` : '',
          attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: parsed => {
      if (!Array.isArray(parsed.patches) || parsed.patches.length === 0 || parsed.patches.length > input.chapterNumbers.length) {
        throw new NovelPipelineError('OUTPUT_INVALID', `分卷「${input.contract.name}」定点修复必须返回候选章节的最小非空子集`)
      }
      const seen = new Set<number>()
      const requiresPayoffRepair = clusterIssues.some(issue => issue.code === 'PAYOFF_DEBT_STREAK')
      let payoffRepairSatisfied = false
      const patches: Array<{
        chapterNumber: number
        chapter: VolumeGateChapter
        fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1]
      }> = []
  for (const value of parsed.patches) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NovelPipelineError('OUTPUT_INVALID', '章节定点修复补丁不是对象')
    }
    const patch = value as Record<string, unknown>
    const chapterNumber = intField(patch, 'chapterNumber', '章节定点修复补丁')
    if (!input.chapterNumbers.includes(chapterNumber) || seen.has(chapterNumber)) {
      throw new NovelPipelineError('REPAIR_BOUNDARY', `章节修复补丁越出点名范围或重复：第 ${chapterNumber} 章`)
    }
    seen.add(chapterNumber)
    const chapter = chaptersByNumber.get(chapterNumber)!
    const diagnosis = parseChapterDiagnosis(chapter)
    if (!Array.isArray(patch.operations) || patch.operations.length === 0 || patch.operations.length > 6) {
      throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁 operations 必须包含 1-6 项`)
    }
    let outline = String(chapter.outline ?? '')
    let nextHook = String(chapter.next_hook ?? '')
    const dramaticContract = diagnosis.dramatic_contract && typeof diagnosis.dramatic_contract === 'object'
      && !Array.isArray(diagnosis.dramatic_contract)
      ? { ...diagnosis.dramatic_contract as Record<string, unknown> }
      : {}
    const tensionPlan = diagnosis.tension_plan && typeof diagnosis.tension_plan === 'object'
      && !Array.isArray(diagnosis.tension_plan)
      ? { ...diagnosis.tension_plan as Record<string, unknown> }
      : {}
    let outlineChanged = false
    let nextHookChanged = false
    let diagnosisChanged = false
    let dramaticContractChanged = false
    let tensionPayoffChanged = false
    for (const rawOperation of patch.operations) {
      if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
        throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁 operation 非法`)
      }
      const operation = rawOperation as Record<string, unknown>
      const field = textField(operation, 'field', `第 ${chapterNumber} 章最小补丁`) as NovelVolumeGateRepairField
      if (!(NOVEL_VOLUME_GATE_REPAIR_FIELDS as readonly string[]).includes(field)) {
        throw new NovelPipelineError('REPAIR_BOUNDARY', `第 ${chapterNumber} 章补丁试图修改禁止字段 ${field}`)
      }
      const oldText = textField(operation, 'oldText', `第 ${chapterNumber} 章最小补丁`)
      const newText = textField(operation, 'newText', `第 ${chapterNumber} 章最小补丁`)
      if (field === 'outline') {
        outline = replaceUniqueRepairText({ chapterNumber, field, current: outline, oldText, newText })
        outlineChanged = true
      } else if (field === 'next_hook') {
        nextHook = replaceUniqueRepairText({ chapterNumber, field, current: nextHook, oldText, newText })
        nextHookChanged = true
      } else if (field === 'tension_plan.payoff_type') {
        const current = String(tensionPlan.payoff_type ?? '')
        const payoffType = replaceUniqueRepairText({ chapterNumber, field, current, oldText, newText })
        if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) {
          throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章 tension_plan.payoff_type 非法`)
        }
        tensionPlan.payoff_type = payoffType
        diagnosisChanged = true
        tensionPayoffChanged = true
      } else {
        const key = field.slice('dramatic_contract.'.length)
        const current = String(dramaticContract[key] ?? '')
        dramaticContract[key] = replaceUniqueRepairText({ chapterNumber, field, current, oldText, newText })
        diagnosisChanged = true
        dramaticContractChanged = true
      }
    }
    if (
      tensionPayoffChanged
      && ['partial', 'major'].includes(String(tensionPlan.payoff_type ?? ''))
      && (outlineChanged || dramaticContractChanged)
    ) {
      payoffRepairSatisfied = true
    }
    if (!outlineChanged && !nextHookChanged && !diagnosisChanged) {
      throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁没有产生变更`)
    }
    patches.push({
      chapterNumber,
      chapter,
      fields: {
        ...(outlineChanged ? { outline } : {}),
        ...(nextHookChanged ? { next_hook: nextHook } : {}),
        ...(diagnosisChanged ? {
          outline_diagnosis: JSON.stringify({
            ...diagnosis,
            dramatic_contract: dramaticContract,
            tension_plan: tensionPlan
          })
        } : {})
      }
    })
  }
  if (requiresPayoffRepair && !payoffRepairSatisfied) {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      'PAYOFF_DEBT_STREAK 修复必须同时产生 partial/major 阶段兑现，并修改大纲或戏剧合同作为剧情依据'
    )
  }
      return patches
    }
  })
  const versions = volumeChapterDAO.updateChaptersWithVersionsAtomic(validatedPatches.map(patch => ({
    chapterId: patch.chapter.id,
    fields: patch.fields
  })))
  return versions.map((version, index) => ({
    ...version,
    chapterNumber: validatedPatches[index].chapterNumber
  }))
}

export async function runVolumeChapterGate(
  workId: number,
  goal: string,
  contract: NovelVolumeContract,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ score: number; rounds: number }> {
  const volume = volumeChapterDAO.listVolumes(workId).find(item => item.name === contract.name)
  if (!volume) throw new NovelPipelineError('PREREQUISITE_MISSING', `分卷「${contract.name}」尚未落库`)
  const availableChapterNumbers = Array.from(
    { length: contract.endChapter - contract.startChapter + 1 },
    (_, index) => contract.startChapter + index
  )
  let savedCheckpoint = readNovelGoalState(workId).chapterVolumeGateCheckpoint
  if (savedCheckpoint?.version === 2
    && savedCheckpoint.volume === contract.name
    && savedCheckpoint.repairProtocolVersion !== NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION) {
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: undefined, failure: undefined })
    savedCheckpoint = undefined
    onProgress?.(`检测到旧版自动修复检查点，已保留现有章节并从「${contract.name}」门禁重新诊断`)
  }
  if (savedCheckpoint?.version === 2 && savedCheckpoint.volume === contract.name && savedCheckpoint.stalled) {
    savedCheckpoint = {
      ...savedCheckpoint,
      round: 1,
      assessments: [],
      aggregate: undefined,
      repair: undefined,
      stalled: undefined,
      repairControl: savedCheckpoint.repairControl
        ? { ...savedCheckpoint.repairControl, lastRoundVersions: [] }
        : undefined
    }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: savedCheckpoint, failure: undefined })
    onProgress?.(`检测到旧的分卷暂停检查点，已保留作品和改写预算并自动重开只读诊断`)
  }
  let rounds = savedCheckpoint?.version === 2
    && savedCheckpoint.volume === contract.name
    && savedCheckpoint.round >= 1
    ? savedCheckpoint.round - 1
    : 0
  let lastScore = -1

  const blockVolumeGate = (
    checkpoint: NovelVolumeGateCheckpoint,
    issues: NovelVolumeGateIssue[],
    score: number,
    reason: string,
    rollback = false
  ): never => {
    const versions = checkpoint.repairControl?.lastRoundVersions ?? []
    if (rollback && versions.length > 0) volumeChapterDAO.restoreVersionsAtomic(versions)
    const state = readNovelGoalState(workId)
    const previous = state.volumeGateDeferredIssues ?? []
    const entry = {
      volume: contract.name,
      score,
      rounds,
      reason,
      deferredAt: new Date().toISOString(),
      issues: issues.map(issue => ({
        source: issue.source,
        code: issue.code,
        problem: issue.problem,
        repairChapterNumbers: [...issue.repairChapterNumbers],
        requiredFix: issue.requiredFix
      }))
    }
    updateNovelGoalState(workId, {
      chapterVolumeGateCheckpoint: checkpoint,
      volumeGateDeferredIssues: [...previous.filter(item => item.volume !== contract.name), entry]
    })
    onProgress?.(
      `「${contract.name}」硬门禁阻断：仍有 ${issues.length} 个问题；已保留检查点和证据账本（${score}分）`
    )
    throw new NovelPipelineError(
      'VOLUME_HARD_GATE_BLOCKED',
      `分卷「${contract.name}」硬门禁未通过：${reason}；仍有 ${issues.length} 个证据问题`
    )
  }

  const checkpointScore = (checkpoint: NovelVolumeGateCheckpoint): number => {
    const scores = [
      ...checkpoint.assessments.map(item => item.score),
      ...(checkpoint.aggregate ? [checkpoint.aggregate.score] : [])
    ]
    return scores.length > 0
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
      : 0
  }

  const executePendingRepairs = async (
    checkpoint: NovelVolumeGateCheckpoint
  ): Promise<undefined> => {
    let currentCheckpoint = checkpoint
    let repair = currentCheckpoint.repair
    if (!repair) return
    // A checkpoint may have been written by the previous planner before the
    // evidence-based candidate reassignment was introduced. If no wave is
    // active, replan its queued issues against the current rewrite budget
    // before validating the next wave; never retry an exhausted sole target.
    if ((currentCheckpoint.repairControl?.waveChapterNumbers ?? []).length === 0) {
      const replanned = planNovelVolumeGateRepairClusters(
        repair.clusters.flatMap(cluster => cluster.issues),
        currentCheckpoint.repairControl,
        availableChapterNumbers
      )
      currentCheckpoint = {
        ...currentCheckpoint,
        repair: { clusters: replanned, nextClusterIndex: 0 }
      }
      repair = currentCheckpoint.repair
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: currentCheckpoint })
    }
    const pendingIssues = repair.clusters.flatMap(cluster => cluster.issues)
    const waveClusters = selectNovelVolumeRepairWave(
      repair.clusters,
      repair.nextClusterIndex,
      currentCheckpoint.repairControl?.waveChapterNumbers ?? []
    )
    const allTargets = [...new Set(waveClusters.flatMap(cluster => cluster.chapterNumbers))]
    if (waveClusters.length === 0) {
      return blockVolumeGate(
        currentCheckpoint,
        repair.clusters.flatMap(cluster => cluster.issues),
        checkpointScore(currentCheckpoint),
        '修复队列中不存在可执行的根因波次'
      )
    }
    const budget = checkNovelVolumeRepairBudget({
      chapterNumbers: allTargets,
      control: currentCheckpoint.repairControl
    })
    if (!budget.allowed) {
      return blockVolumeGate(
        currentCheckpoint,
        pendingIssues,
        checkpointScore(currentCheckpoint),
        budget.reason ?? '恢复修复队列时达到安全改写边界'
      )
    }
    let current: NovelVolumeGateCheckpoint = {
      ...currentCheckpoint,
      repairControl: budget.control
    }
    const waveEndIndex = repair.nextClusterIndex + waveClusters.length
    for (let clusterIndex = repair.nextClusterIndex; clusterIndex < waveEndIndex; clusterIndex++) {
      if (signal?.aborted) throw new Error('已取消')
      let cluster = repair.clusters[clusterIndex]
      onProgress?.(`正在修复第 ${cluster.chapterNumbers.join('、')} 章（${clusterIndex + 1}/${repair.clusters.length}）`)
      let versions: Array<{ chapterId: number; versionId: number; chapterNumber: number }> | undefined
      let retryHint = ''
      let protocolFailures = 0
      while (!versions) {
        if (signal?.aborted) throw new Error('已取消')
        try {
          versions = await repairVolumeChapterCluster({
            workId,
            goal,
            contract,
            volumeId: volume.id,
            chapterNumbers: cluster.chapterNumbers,
            issues: cluster.issues,
            retryHint,
            signal
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          if (
            (error instanceof NovelPipelineError && (error.code === 'OUTPUT_INVALID' || error.code === 'REPAIR_BOUNDARY'))
            || /OUTPUT_INVALID|REPAIR_BOUNDARY|本地 Schema 校验失败|结构化输出无效/i.test(errorMessage)
          ) {
            // A malformed/no-op patch is local to this leaf transaction. Keep
            // the checkpoint and retry the same cluster until a valid patch is
            // produced; it must never terminate the volume gate.
            onProgress?.(`第 ${cluster.chapterNumbers.join('、')} 章补丁未通过校验，保留检查点并继续重试：${errorMessage}`)
            retryHint = errorMessage
            protocolFailures += 1
            if (protocolFailures >= 2) {
              const currentTargets = new Set(cluster.chapterNumbers)
              const alternateIssues = cluster.issues.map(issue => ({
                ...issue,
                repairChapterNumbers: [...new Set([
                  ...issue.repairChapterNumbers,
                  ...issue.evidence.map(item => item.chapterNumber)
                ])].filter(number => availableChapterNumbers.includes(number) && !currentTargets.has(number))
              })).filter(issue => issue.repairChapterNumbers.length > 0)
              const alternateClusters = planNovelVolumeGateRepairClusters(
                alternateIssues,
                current.repairControl,
                availableChapterNumbers
              )
              const alternate = alternateClusters.find(candidate =>
                candidate.chapterNumbers.some(number => !currentTargets.has(number))
              )
              if (alternate) {
                cluster = alternate
                const nextClusters = repair.clusters.map((item, index) => index === clusterIndex ? alternate : item)
                repair = { ...repair, clusters: nextClusters }
                current = {
                  ...current,
                  repair,
                  repairControl: {
                    ...current.repairControl!,
                    waveChapterNumbers: [...new Set([
                      ...(current.repairControl?.waveChapterNumbers ?? []),
                      ...alternate.chapterNumbers
                    ])]
                  }
                }
                updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: current })
                retryHint = `${errorMessage}；已改派到第 ${alternate.chapterNumbers.join('、')} 章，必须输出不同字段或文本。`
                protocolFailures = 0
                continue
              }
              return blockVolumeGate(
                current,
                pendingIssues,
                checkpointScore(current),
                `当前修复目标连续两次协议失败且不存在未尝试的责任章节：${errorMessage}`
              )
            }
            await new Promise(resolve => setTimeout(resolve, 500))
            continue
          }
          throw error
        }
      }
      const refreshed = volumeChapterDAO.listChapters(volume.id)
      const control = current.repairControl!
      const rewriteCounts = { ...control.rewriteCounts }
      const changedChapterNumbers = [...new Set(versions.map(version => version.chapterNumber))]
      for (const chapterNumber of changedChapterNumbers) {
        rewriteCounts[String(chapterNumber)] = (rewriteCounts[String(chapterNumber)] ?? 0) + 1
      }
      const previouslyChanged = control.changedChapterNumbers.filter(number => !cluster.chapterNumbers.includes(number))
      current = {
        ...current,
        snapshotFingerprint: volumeGateSnapshotFingerprint(refreshed),
        repairControl: {
          ...control,
          changedChapterNumbers: [...new Set([...previouslyChanged, ...changedChapterNumbers])],
          waveChapterNumbers: [...new Set([...(control.waveChapterNumbers ?? []), ...changedChapterNumbers])],
          rewriteCounts,
          lastRoundVersions: [
            ...control.lastRoundVersions,
            ...versions.map(({ chapterId, versionId }) => ({ chapterId, versionId }))
          ]
        },
        repair: { ...repair, nextClusterIndex: clusterIndex + 1 }
      }
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: current })
    }
    const refreshed = volumeChapterDAO.listChapters(volume.id)
    const windows = planNovelVolumeGateWindows(contract.startChapter, contract.endChapter)
    const reusableAssessments = checkpoint.assessments.filter(assessment => {
      if (!assessment.passed || !assessment.inputFingerprint) return false
      const range = windows.find(item => `${item.startChapter}-${item.endChapter}` === assessment.key)
      return !!range && assessment.inputFingerprint === volumeGateWindowFingerprint({
        chapters: refreshed,
        contractStartChapter: contract.startChapter,
        range
      })
    })
    updateNovelGoalState(workId, {
      chapterVolumeGateCheckpoint: {
        version: 2,
        repairProtocolVersion: NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION,
        volume: contract.name,
        round: checkpoint.round + 1,
        snapshotFingerprint: volumeGateSnapshotFingerprint(refreshed),
        assessments: reusableAssessments,
        repairControl: current.repairControl
          ? { ...current.repairControl, waveChapterNumbers: [], completedWaveCount: (current.repairControl.completedWaveCount ?? 0) + 1 }
          : current.repairControl
      }
    })
  }

  while (true) {
    rounds++
    const chapters = volumeChapterDAO.listChapters(volume.id)
    if (chapters.length !== contract.endChapter - contract.startChapter + 1) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${contract.name}」章节大纲尚未完整，不能执行整卷门禁`)
    }
    const windows = planNovelVolumeGateWindows(contract.startChapter, contract.endChapter)
    const snapshotFingerprint = volumeGateSnapshotFingerprint(chapters)
    const currentSaved = readNovelGoalState(workId).chapterVolumeGateCheckpoint
    const savedMatchesSnapshot = currentSaved?.version === 2
      && currentSaved.repairProtocolVersion === NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION
      && currentSaved.volume === contract.name
      && currentSaved.round === rounds
      && currentSaved.snapshotFingerprint === snapshotFingerprint
    let checkpoint: NovelVolumeGateCheckpoint = savedMatchesSnapshot
      ? currentSaved
      : {
          version: 2,
          repairProtocolVersion: NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION,
          volume: contract.name,
          round: rounds,
          snapshotFingerprint,
          assessments: []
        }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    if (checkpoint.repair) {
      onProgress?.(`正在从断点恢复「${contract.name}」定点修复（已完成 ${checkpoint.repair.nextClusterIndex}/${checkpoint.repair.clusters.length} 个小簇）`)
      const deferred = await executePendingRepairs(checkpoint)
      if (deferred) return deferred
      continue
    }
    onProgress?.(`正在诊断「${contract.name}」章节大纲第 ${rounds} 轮：共 ${windows.length} 个连续窗口`)
    const assessments: NovelVolumeGateAssessment[] = []
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      if (signal?.aborted) throw new Error('已取消')
      const range = windows[windowIndex]
      const key = `${range.startChapter}-${range.endChapter}`
      const inputFingerprint = volumeGateWindowFingerprint({
        chapters,
        contractStartChapter: contract.startChapter,
        range
      })
      const saved = checkpoint.assessments.find(item => item.key === key && item.inputFingerprint === inputFingerprint)
      if (saved) {
        assessments.push(saved)
        onProgress?.(`已从断点恢复「${contract.name}」第 ${key} 章窗口（${windowIndex + 1}/${windows.length}）`)
        continue
      }
      onProgress?.(`正在检查「${contract.name}」第 ${key} 章窗口（${windowIndex + 1}/${windows.length}）`)
      const assessment = await assessVolumeChapterWindow({ workId, goal, contract, chapters, range, signal })
      assessments.push(assessment)
      checkpoint = { ...checkpoint, assessments: [...checkpoint.assessments, assessment] }
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    }

    const deterministicIssues = deterministicVolumeGateIssues(workId, contract, chapters)
    let aggregate = checkpoint.aggregate
    const windowIssues = assessments.flatMap(item => item.issues)
    if (windowIssues.length === 0 && deterministicIssues.length === 0) {
      if (!aggregate) {
        onProgress?.(`正在对「${contract.name}」执行只读卷级汇总（不生成修复补丁）`)
        aggregate = await assessVolumeChapterAggregate({ workId, goal, contract, chapters, assessments, signal })
        checkpoint = { ...checkpoint, aggregate }
        updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
      }
    } else {
      aggregate = undefined
    }
    const issues = [...windowIssues, ...deterministicIssues, ...(aggregate?.issues ?? [])]
    const scoreRows = [...assessments.map(item => item.score), ...(aggregate ? [aggregate.score] : [])]
    lastScore = scoreRows.length > 0
      ? Math.round(scoreRows.reduce((sum, value) => sum + value, 0) / scoreRows.length)
      : 0
    const passed = assessments.every(item => item.passed)
      && deterministicIssues.length === 0
      && !!aggregate?.passed
      && issues.length === 0
    if (passed) {
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: undefined })
      onProgress?.(`「${contract.name}」窗口门禁与只读卷级汇总均通过（${lastScore}分）`)
      return { score: lastScore, rounds }
    }
    if (issues.length === 0) {
      throw new NovelPipelineError('OUTPUT_INVALID', `分卷「${contract.name}」门禁未通过，但没有证据点名的修复目标`)
    }
    const control = checkpoint.repairControl
    const issueFingerprint = novelVolumeGateIssueFingerprint(issues)
    const clusters = planNovelVolumeGateRepairClusters(issues, control, availableChapterNumbers)
    // Do not evaluate the entire repair queue against the per-wave budget here.
    // A volume may legitimately have more than six affected chapters; the queue
    // is executed in bounded waves by executePendingRepairs, which applies the
    // same budget to only the active wave. Checking all clusters at this point
    // would reject the run before the first wave can be created.
    const baseControl = control ?? {
      changedChapterNumbers: [],
      rewriteCounts: {},
      lastRoundVersions: []
    }
    checkpoint = {
      ...checkpoint,
      aggregate,
      repairControl: {
        ...baseControl,
        previousIssueCount: issues.length,
        previousIssueFingerprint: issueFingerprint,
        waveChapterNumbers: [],
        lastRoundVersions: []
      },
      repair: { clusters, nextClusterIndex: 0 }
    }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    onProgress?.(`「${contract.name}」发现 ${issues.length} 个证据问题，将定点修复 ${clusters.length} 个小簇`)
    const deferred = await executePendingRepairs(checkpoint)
    if (deferred) return deferred
  }
  const checkpoint = readNovelGoalState(workId).chapterVolumeGateCheckpoint
  const unresolved = [
    ...(checkpoint?.assessments.flatMap(item => item.issues) ?? []),
    ...(checkpoint?.aggregate?.issues ?? []),
    ...(checkpoint?.repair?.clusters.flatMap(cluster => cluster.issues) ?? [])
  ]
  return blockVolumeGate(
    checkpoint ?? {
      version: 2,
      repairProtocolVersion: NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION,
      volume: contract.name,
      round: Math.max(1, rounds),
      snapshotFingerprint: volumeGateSnapshotFingerprint(volumeChapterDAO.listChapters(volume.id)),
      assessments: []
    },
    unresolved.length > 0 ? unresolved : [{
      source: 'deterministic',
      code: 'VOLUME_GATE_UNRESOLVED',
      problem: '分卷自动修复未收敛，禁止继续生成后续章节',
      repairChapterNumbers: [],
      evidence: [],
      requiredFix: '从当前检查点完成定点修复并重新执行整卷硬门禁'
    }],
    Math.max(0, lastScore),
    '分卷自动修复循环结束但质量问题尚未清零'
  )
}

export function normalizeCharacters(value: unknown, chapterNumber: number): string[] {
  if (!Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 characters 必须是数组`)
  }
  const names = value.map(String).map(s => s.trim()).filter(Boolean)
  if (names.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章没有出场角色`)
  }
  return [...new Set(names)]
}

export function validateDramaticContract(value: unknown, chapterNumber: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少 dramatic_contract`)
  }
  const contract = value as Record<string, unknown>
  for (const key of ['scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'turn', 'irreversible_change', 'next_question']) {
    textField(contract, key, `第 ${chapterNumber} 章 dramatic_contract`)
  }
  return contract
}

export function validatePatternContract(value: unknown, chapterNumber: number): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少 pattern_contract`)
  }
  const row = value as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const key of [
    'conflict_type', 'protagonist_method', 'antagonist_tactic', 'anticipated_opponent_adjustment',
    'location_type', 'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
  ]) {
    result[key] = textField(row, key, `第 ${chapterNumber} 章 pattern_contract`)
  }
  return result
}

export function budgetKey(budget: { owner?: string | null; resource: string }): string {
  return `${budget.owner?.trim() || '*'}::${budget.resource.trim()}`
}

export function resourceBudgetExample(
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

export function previousResourceBudgetContext(previousBudgets: Map<string, ChapterResourceBudgetInput>): string {
  if (previousBudgets.size === 0) return ''
  return [
    '【上一章资源预算 - 本批第一章必须严格承接】',
    ...Array.from(previousBudgets.entries()).map(([key, budget]) =>
      `- ${key}：上一章章末 ${budget.end_min}-${budget.end_max}${budget.unit || ''}；本批第一章 start_min/start_max 必须与该区间相交`)
  ].join('\n')
}

export function isNumericConstraint(constraint: ReturnType<typeof resourceLedgerDAO.listConstraints>[number]): boolean {
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

export function validateResourceBudgets(
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
