import type { WebContents } from 'electron'
import { modelService } from '../../model'
import type { AiSessionHandle } from '../../ai/ai-session-manager'
import type { SegmentDetectDetail } from '../../perplexity'
import { ZHUQUE_HUMAN_RISK_CEILING } from '../../perplexity/zhuque-rewrite-risk'
import type { WorkModelOptions } from '../../../shared/work-model-options'
import type { AigcDistribution } from '../../../shared/aigc-detect-types'
import type { HumanRewriteReference } from '../../../shared/human-rewrite-reference-types'
import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_SCENE_TYPES,
  type HumanRewriteAiSymptom,
  type HumanRewriteSceneType
} from '../../../shared/human-rewrite-reference-types'
import type {
  AigcRewriteGoalResult,
  AigcSentencePatch,
  AigcSentenceRewriteAttempt,
  AigcSentenceRewriteResult,
  StableRewriteBlock
} from '../../../shared/aigc-sentence-rewrite-types'
import { AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT } from '../../../shared/aigc-sentence-rewrite-types'
import { planSceneRewriteBlocks, splitStableSentences } from '../../../shared/aigc-sentence-patches'
import {
  computeChangeRatio,
  computeDialogueRetention,
  computeNumberAnchorRetention
} from './aigc-rewrite-quality'
import {
  computeNarrativeChangeRatio,
  computePassedRewriteCoverage,
  findSceneRewriteProseIssues
} from './aigc-scene-rewrite-quality'
import {
  findCopiedReferencePhrase,
  formatHumanRewriteReferences,
  selectHumanRewriteReferences
} from './human-rewrite-reference'
import {
  extractJsonObject,
  parseSentenceAssessments,
  type SentenceAssessment
} from './aigc-sentence-assessment'

const MAX_GENERATION_ATTEMPTS = 2
const MAX_CLASSIFY_ATTEMPTS = 3
const MIN_BLOCK_CHANGE_RATIO = 0.24
const MIN_NARRATIVE_CHANGE_RATIO = 0.34
const TARGET_CHANGE_RATIO = 0.48
const REQUIRED_TARGET_COVERAGE = AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT / 100

const BLOCK_ANALYZE_SYSTEM = [
  '你是人工化改写的句级诊断器。输入是一个由相邻句组成的语义块。',
  '必须逐项分析每个句子，不得遗漏，不得改写文本。',
  'mustRewrite=true 的句子必须返回 shouldRewrite=true。',
  `sceneTypes 只能逐字使用：${HUMAN_REWRITE_SCENE_TYPES.join(', ')}`,
  `aiSymptoms 只能逐字使用：${HUMAN_REWRITE_AI_SYMPTOMS.join(', ')}`,
  'evidence 必须引用该句中的具体表达或结构。',
  'factAnchors 必须是原句中逐字存在且改写后必须保留的人名、地名、特殊物件、身份状态或数值；没有则返回空数组。',
  '只返回 JSON：{"items":[{"id":0,"shouldRewrite":true,"sceneTypes":["narration"],"aiSymptoms":["regular_sentence_rhythm"],"evidence":"具体证据","factAnchors":["人物名","关键物件"]}]}'
].join('\n')

const BLOCK_REWRITE_SYSTEM = [
  '你是专业小说编辑。只重写给出的【目标语义块】，上下文不得输出。',
  '依据逐句诊断重新组织整个场景块。必须重建信息先后、句子长短和叙述落点，禁止只做倒装、合句、近义词替换。',
  '必须保持人物姓名、事件、事实、指代、时态、因果关系和叙事顺序不变。',
  '引号内对话和全部数字必须逐字保留。不得添加新人物、新事实、新动机或新结果。',
  '允许自由拆句、并句和重组段落；短对白要与动作、反应或叙事承接共同组织，不能孤立地原样保留整块。',
  '每段必须以完整句末标点结束。禁止段尾逗号、超长流水句、重复短语、随机口语、错字、生僻词和病句。',
  '候选一采用场景重写：压缩逐帧动作，改变信息落点；候选二采用节奏重写：拉开句长和信息密度，保留自然停顿。',
  '只返回 JSON：{"candidates":[{"key":"场景重写","text":"..."},{"key":"节奏重写","text":"..."}]}'
].join('\n')

interface BlockState {
  anchor: StableRewriteBlock
  segmentStart: number
  text: string
  initialRisk: number
  sceneTypes: HumanRewriteSceneType[]
  aiSymptoms: HumanRewriteAiSymptom[]
  factAnchors: string[]
  evidence: string
  referenceTitles: string[]
  issues: string[]
  attempts: AigcSentenceRewriteAttempt[]
  status: AigcSentencePatch['status']
  touched: boolean
}

interface CandidateEvaluation {
  key: string
  text: string
  changePercent: number
  narrativeChangePercent: number
  selectionCost: number
  issues: string[]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function preserveOuterWhitespace(original: string, rewritten: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? ''
  const trailing = original.match(/\s*$/)?.[0] ?? ''
  return `${leading}${rewritten.trim()}${trailing}`
}

function locateSegments(details: SegmentDetectDetail[]) {
  let cursor = 0
  return details.map(detail => {
    const start = cursor
    cursor += detail.text.length
    return { start, end: cursor, detail }
  })
}

function computeInitialBlockRisks(blocks: StableRewriteBlock[], details: SegmentDetectDetail[]): number[] {
  const located = locateSegments(details)
  return blocks.map(block => {
    let weighted = 0
    let total = 0
    for (const item of located) {
      const overlap = Math.max(0, Math.min(block.end, item.end) - Math.max(block.start, item.start))
      if (overlap <= 0) continue
      weighted += item.detail.aiScore * overlap
      total += overlap
    }
    return total > 0 ? round(weighted / total) : 0
  })
}

async function analyzeBlock(
  state: BlockState,
  details: SegmentDetectDetail[],
  session: AiSessionHandle,
  forceRewrite: boolean,
  modelOpts?: WorkModelOptions
): Promise<Map<number, SentenceAssessment>> {
  const units = splitStableSentences(state.anchor.text)
  const required = new Set<number>()
  const sentences = units.map((unit, index) => {
    const detail = details[index]
    if (forceRewrite || (detail?.aiScore ?? state.initialRisk) >= ZHUQUE_HUMAN_RISK_CEILING) required.add(index)
    return {
      id: index,
      mustRewrite: required.has(index),
      text: unit.text.trim(),
      detectorRisk: round(detail?.aiScore ?? state.initialRisk),
      detectorReason: detail?.reason ?? ''
    }
  })
  const payload = JSON.stringify({ sentences }, null, 2)
  let retryFeedback = ''
  for (let attempt = 1; attempt <= MAX_CLASSIFY_ATTEMPTS; attempt++) {
    const response = await modelService.chat({
      prompt: [payload, retryFeedback].filter(Boolean).join('\n\n'),
      systemPrompt: BLOCK_ANALYZE_SYSTEM,
      step: 'ai_trace_polish',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.1,
      maxTokens: Math.max(1200, units.length * 220),
      modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: false
    }, { sessionHandle: session, keepSession: true, stream: false })
    if (response.cancelled) throw new Error('已取消')
    if (!response.success || !response.content?.trim()) throw new Error(response.error || '语义块逐句诊断失败')
    try {
      return parseSentenceAssessments(
        response.content,
        units.length,
        required,
        units.map(unit => unit.text)
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === MAX_CLASSIFY_ATTEMPTS) {
        throw new Error(`语义块逐句诊断连续 ${MAX_CLASSIFY_ATTEMPTS} 次失败：${message}`)
      }
      retryFeedback = [
        '上一轮违反严格JSON契约。',
        `错误：${message}`,
        `原始输出：${response.content}`,
        `sceneTypes 只能逐字使用：${HUMAN_REWRITE_SCENE_TYPES.join(', ')}`,
        `aiSymptoms 只能逐字使用：${HUMAN_REWRITE_AI_SYMPTOMS.join(', ')}`,
        '重新返回完整JSON，不得解释。'
      ].join('\n')
    }
  }
  throw new Error('语义块逐句诊断未完成')
}

function aggregateAssessment(assessments: Map<number, SentenceAssessment>) {
  const values = Array.from(assessments.values()).filter(item => item.shouldRewrite)
  return {
    sceneTypes: Array.from(new Set(values.flatMap(item => item.sceneTypes))).slice(0, 2),
    aiSymptoms: Array.from(new Set(values.flatMap(item => item.aiSymptoms))).slice(0, 3),
    reason: values.map(item => item.reason).filter(Boolean).join('；'),
    factAnchors: Array.from(new Set(values.flatMap(item => item.factAnchors))).slice(0, 24)
  }
}

async function generateBlockCandidates(params: {
  state: BlockState
  previousText: string
  nextText: string
  diagnosis: ReturnType<typeof aggregateAssessment>
  references: HumanRewriteReference[]
  retryFeedback: string
  session: AiSessionHandle
  modelOpts?: WorkModelOptions
}): Promise<Array<{ key: string; text: string }>> {
  const { state, previousText, nextText, diagnosis, references, retryFeedback, session, modelOpts } = params
  const referenceBlock = references.length > 0
    ? `【改写案例，只学习信息取舍，禁止复制】\n${formatHumanRewriteReferences(references)}`
    : ''
  const response = await modelService.chat({
    prompt: [
      `【上文】\n${previousText.slice(-600)}`,
      `【目标语义块】\n${state.text}`,
      `【下文】\n${nextText.slice(0, 600)}`,
      `【逐句诊断】\n场景：${diagnosis.sceneTypes.join(', ')}\n症状：${diagnosis.aiSymptoms.join(', ')}\n证据：${diagnosis.reason}`,
      `【必须逐字保留的事实锚点】\n${diagnosis.factAnchors.length > 0 ? diagnosis.factAnchors.join('、') : '无额外锚点'}`,
      referenceBlock,
      retryFeedback ? `【上一轮候选失败反馈】\n${retryFeedback}` : ''
    ].filter(Boolean).join('\n\n'),
    systemPrompt: BLOCK_REWRITE_SYSTEM,
    step: 'ai_trace_polish',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    temperature: 0.72,
    maxTokens: Math.max(1600, state.text.length * 3),
    modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
    modelName: modelOpts?.modelName,
    thinkingEnabled: modelOpts?.thinkingEnabled
  }, { sessionHandle: session, keepSession: true, stream: false })
  if (response.cancelled) throw new Error('已取消')
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '语义块改写失败')
  const json = extractJsonObject(response.content)
  if (!json) throw new Error('语义块改写未返回有效JSON')
  const parsed = JSON.parse(json) as { candidates?: unknown[] }
  if (!Array.isArray(parsed.candidates)) throw new Error('语义块改写没有返回candidates数组')
  const candidates = parsed.candidates.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const rawText = typeof item.text === 'string' ? item.text.trim() : ''
    if (!rawText) return []
    const key = typeof item.key === 'string' && item.key.trim() ? item.key.trim() : `候选${index + 1}`
    return [{ key, text: preserveOuterWhitespace(state.anchor.text, rawText) }]
  })
  if (candidates.length !== 2) throw new Error(`语义块改写必须返回2个候选，实际${candidates.length}个`)
  return candidates
}

function evaluateCandidate(
  state: BlockState,
  candidate: { key: string; text: string },
  references: HumanRewriteReference[]
): CandidateEvaluation {
  const issues: string[] = []
  const changeRatio = computeChangeRatio(state.anchor.text, candidate.text)
  const narrativeChangeRatio = computeNarrativeChangeRatio(state.anchor.text, candidate.text)
  const lengthRatio = candidate.text.length / Math.max(1, state.anchor.text.length)
  if (changeRatio < MIN_BLOCK_CHANGE_RATIO) issues.push(`场景块改动不足${MIN_BLOCK_CHANGE_RATIO * 100}%`)
  if (narrativeChangeRatio < MIN_NARRATIVE_CHANGE_RATIO) {
    issues.push(`非对话叙述改动不足${MIN_NARRATIVE_CHANGE_RATIO * 100}%`)
  }
  if (lengthRatio < 0.72 || lengthRatio > 1.35) issues.push(`长度比例${round(lengthRatio)}超出0.72-1.35`)
  if (computeNumberAnchorRetention(state.anchor.text, candidate.text) < 1) issues.push('数字事实未完整保留')
  if (computeDialogueRetention(state.anchor.text, candidate.text) < 1) issues.push('引号内对话未逐字保留')
  const missingAnchors = state.factAnchors.filter(anchor => !candidate.text.includes(anchor))
  if (missingAnchors.length > 0) issues.push(`事实锚点缺失：${missingAnchors.join('、')}`)
  issues.push(...findSceneRewriteProseIssues(state.anchor.text, candidate.text))
  const copied = findCopiedReferencePhrase(candidate.text, references)
  if (copied) issues.push(`复制了案例“${copied.referenceTitle}”的连续原句`)
  const selectionCost = Math.abs(changeRatio - TARGET_CHANGE_RATIO) * 100 +
    Math.abs(narrativeChangeRatio - 0.55) * 60 + Math.abs(lengthRatio - 1) * 20
  return {
    key: candidate.key,
    text: candidate.text,
    changePercent: round(changeRatio * 100),
    narrativeChangePercent: round(narrativeChangeRatio * 100),
    selectionCost,
    issues: Array.from(new Set(issues))
  }
}

function retryFeedback(evaluations: CandidateEvaluation[]): string {
  return evaluations.map((item, index) => [
    `候选${index + 1}（${item.key}），整块改动${item.changePercent}%，非对话叙述改动${item.narrativeChangePercent}%`,
    `失败原因：${item.issues.join('；') || '无'}`
  ].join('\n')).join('\n\n')
}

export async function runBlockRewrite(params: {
  sender: WebContents
  runId: string
  session: AiSessionHandle
  input: string
  segments: SegmentDetectDetail[]
  initialDistribution: AigcDistribution
  fullDocumentRewrite: boolean
  strongMode: boolean
  references: HumanRewriteReference[]
  modelOpts?: WorkModelOptions
}): Promise<AigcSentenceRewriteResult> {
  const {
    sender,
    runId,
    session,
    input,
    segments,
    initialDistribution,
    fullDocumentRewrite,
    strongMode,
    references,
    modelOpts
  } = params
  const units = splitStableSentences(input)
  if (units.length !== segments.length) {
    throw new Error(`语义块改写无法建立检测映射：原文${units.length}句，检测结果${segments.length}句`)
  }

  const blocks = planSceneRewriteBlocks(units)
  const risks = computeInitialBlockRisks(blocks, segments)
  let segmentStart = 0
  const states: BlockState[] = blocks.map((anchor, index) => {
    const state: BlockState = {
      anchor,
      segmentStart,
      text: anchor.text,
      initialRisk: risks[index],
      sceneTypes: [],
      aiSymptoms: [],
      factAnchors: [],
      evidence: '',
      referenceTitles: [],
      issues: [],
      attempts: [],
      status: 'analyzing',
      touched: false
    }
    segmentStart += anchor.sentenceIds.length
    return state
  })
  const targetIndices = states
    .map((state, index) => ({ index, risk: state.initialRisk }))
    .filter(item => fullDocumentRewrite || item.risk >= ZHUQUE_HUMAN_RISK_CEILING)
    .map(item => item.index)
  const patches = new Map<string, AigcSentencePatch>()

  const emit = (state: BlockState) => {
    const patch: AigcSentencePatch = {
      id: state.anchor.id,
      scope: 'block',
      sentenceCount: state.anchor.sentenceIds.length,
      start: state.anchor.start,
      end: state.anchor.end,
      segmentIndex: state.segmentStart,
      paragraphIndex: state.anchor.paragraphIndex,
      sentenceIndex: state.anchor.sentenceIndex,
      originalText: state.anchor.text,
      rewrittenText: state.text !== state.anchor.text ? state.text : undefined,
      status: state.status,
      sceneTypes: state.sceneTypes,
      aiSymptoms: state.aiSymptoms,
      evidence: state.evidence,
      referenceTitles: state.referenceTitles,
      issues: state.issues,
      windowScoreBefore: state.initialRisk,
      attempts: state.attempts
    }
    patches.set(patch.id, patch)
    sender.send('lab:aigc-rewrite:sentence', { runId, patch })
  }

  let completedBlocks = 0
  for (const targetIndex of targetIndices) {
    const state = states[targetIndex]
    state.touched = true
    state.status = 'analyzing'
    emit(state)
    sender.send('lab:aigc-rewrite:progress', {
      runId,
      message: `语义块生成${completedBlocks + 1}/${targetIndices.length}：逐句诊断第${targetIndex + 1}块（${state.anchor.sentenceIds.length}句）…`
    })
    const blockDetails = segments.slice(
      state.segmentStart,
      state.segmentStart + state.anchor.sentenceIds.length
    )
    const assessments = await analyzeBlock(state, blockDetails, session, fullDocumentRewrite, modelOpts)
    const diagnosis = aggregateAssessment(assessments)
    state.sceneTypes = diagnosis.sceneTypes
    state.aiSymptoms = diagnosis.aiSymptoms
    state.evidence = diagnosis.reason
    state.factAnchors = diagnosis.factAnchors
    if (diagnosis.aiSymptoms.length === 0) {
      state.status = 'unchanged'
      state.issues = ['该高风险语义块未定位到可验证的句内AI痕迹']
      emit(state)
      completedBlocks++
      continue
    }

    const matched = strongMode ? selectHumanRewriteReferences(diagnosis, references) : []
    state.referenceTitles = matched.map(item => item.title)

    state.status = 'rewriting'
    emit(state)
    let accepted: CandidateEvaluation | undefined
    let feedback = ''
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      sender.send('lab:aigc-rewrite:progress', {
        runId,
        message: `语义块生成${completedBlocks + 1}/${targetIndices.length}：生成第${attempt}/${MAX_GENERATION_ATTEMPTS}轮候选…`
      })
      const candidates = await generateBlockCandidates({
        state,
        previousText: states[targetIndex - 1]?.text ?? '',
        nextText: states[targetIndex + 1]?.text ?? '',
        diagnosis,
        references: matched,
        retryFeedback: feedback,
        session,
        modelOpts
      })
      const evaluations = candidates.map(candidate => evaluateCandidate(state, candidate, matched))
      state.attempts.push({
        attempt: state.attempts.length + 1,
        candidates: evaluations.map(item => ({
          text: item.text,
          score: item.changePercent,
          issues: item.issues
        }))
      })
      accepted = evaluations.filter(item => item.issues.length === 0)
        .sort((left, right) => left.selectionCost - right.selectionCost)[0]
      if (accepted) break
      feedback = retryFeedback(evaluations)
      state.issues = Array.from(new Set(evaluations.flatMap(item => item.issues)))
      emit(state)
    }

    if (!accepted) {
      state.status = 'rejected'
      if (!state.issues.length) state.issues = ['没有候选通过事实与结构质量门禁']
    } else {
      state.text = accepted.text
      state.status = 'passed'
      state.issues = [
        `已通过生成质量门禁，整块改动${accepted.changePercent}%，非对话叙述改动${accepted.narrativeChangePercent}%；尚未重新检测`
      ]
    }
    emit(state)
    completedBlocks++
  }

  const orderedPatches = Array.from(patches.values()).sort((left, right) => left.start - right.start)
  const passedCount = orderedPatches.filter(patch => patch.status === 'passed').length
  const remainingSentenceIds = orderedPatches
    .filter(patch => patch.status !== 'passed')
    .map(patch => patch.id)
  const targetTexts = targetIndices.map(index => states[index].anchor.text)
  const passedTexts = targetIndices
    .filter(index => states[index].status === 'passed')
    .map(index => states[index].anchor.text)
  const passedCoverage = computePassedRewriteCoverage(targetTexts, passedTexts)
  const compactLength = (text: string) => Math.max(1, text.replace(/\s+/g, '').length)
  const targetCoverage = targetTexts.reduce((sum, text) => sum + compactLength(text), 0) /
    compactLength(input)
  const coverageSatisfied = passedCoverage >= REQUIRED_TARGET_COVERAGE
  const goal: AigcRewriteGoalResult = {
    status: targetIndices.length === 0
      ? 'achieved'
      : passedCount > 0 && coverageSatisfied ? 'awaiting_recheck' : 'not_achieved',
    humanPercent: initialDistribution.human,
    suspectedAiPercent: initialDistribution.suspected_ai,
    aiPercent: initialDistribution.ai,
    iterations: completedBlocks,
    remainingSentenceIds,
    targetCoveragePercent: round(targetCoverage * 100),
    passedCoveragePercent: round(passedCoverage * 100),
    fullDocumentRewrite
  }
  const finalText = states.map(state => state.text).join('')
  sender.send('lab:aigc-rewrite:progress', {
    runId,
    message: targetIndices.length === 0
      ? '初始检测已经全部为人工特征，无需改写'
      : coverageSatisfied
        ? `场景块生成完成：${passedCount}/${targetIndices.length}个块通过，覆盖${goal.passedCoveragePercent}%；请应用后手动重新检测`
        : `场景块覆盖仅${goal.passedCoveragePercent}%，未达到${REQUIRED_TARGET_COVERAGE * 100}%质量门禁，拒绝应用不完整改写`
  })
  return { originalText: input, finalText, patches: orderedPatches, goal }
}
