import { modelService } from '../../model'
import { workDAO, volumeChapterDAO } from '../../db'
import type { StoryHarnessIssue } from '../../../shared/story-harness'
import { withGoalLoopModelOptions } from './story-goal-model'
import { requestStructuredModelOutput } from './structured-model-output'

export interface StoryReleasePromiseAssessment {
  passed: boolean
  titlePromise: string
  hookPromise: string
  firstThirtyPercentEvidence: string[]
  climaxEvidence: string[]
  endingEvidence: string[]
  missingPromises: string[]
}

export interface StoryComplianceAssessment {
  passed: boolean
  issues: Array<{
    code: string
    domain: 'legal' | 'medical' | 'financial' | 'privacy' | 'cyberbullying' | 'extreme_revenge' | 'platform'
    evidence: string
    message: string
    requiredAction: string
  }>
}

export interface StoryReleaseReview {
  promise: StoryReleasePromiseAssessment
  compliance: StoryComplianceAssessment
  harnessIssues: StoryHarnessIssue[]
}

export interface StoryReleaseEvidence {
  title: string
  hook: string
  firstThirtyPercent: string
  climaxWindow: string
  ending: string
  fullBody: string
}

function stringList(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value.map(String).map(item => item.trim()).filter(Boolean).slice(0, limit)
    : []
}

function normalizedEvidence(value: string): string {
  return value.replace(/\s+/g, '').replace(/[“”"'‘’]/g, '')
}

function requireSourceEvidence(
  evidence: string[],
  source: string,
  label: string,
  required = true
): void {
  const normalizedSource = normalizedEvidence(source)
  if (required && evidence.length === 0) throw new Error(`${label}缺少原文证据`)
  for (const quote of evidence) {
    const normalizedQuote = normalizedEvidence(quote)
    if (normalizedQuote.length < 4 || !normalizedSource.includes(normalizedQuote)) {
      throw new Error(`${label}包含无法在对应原文定位的证据：${quote.slice(0, 80)}`)
    }
  }
}

function storyEvidence(workId: number): StoryReleaseEvidence {
  const work = workDAO.getById(workId)
  const body = volumeChapterDAO.listChaptersByWork(workId)
    .map(chapter => chapter.content?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
  const firstCut = Math.max(1, Math.ceil(body.length * 0.3))
  const climaxStart = Math.max(0, Math.floor(body.length * 0.55))
  return {
    title: work?.title?.trim() ?? '',
    hook: work?.description?.trim() ?? '',
    firstThirtyPercent: body.slice(0, firstCut),
    climaxWindow: body.slice(climaxStart, Math.max(climaxStart, body.length - Math.floor(body.length * 0.12))),
    ending: body.slice(-Math.min(5200, body.length)),
    fullBody: body
  }
}

export function validateStoryReleasePromiseEvidence(
  value: Record<string, unknown>,
  source: StoryReleaseEvidence
): StoryReleasePromiseAssessment {
  if (typeof value.passed !== 'boolean') throw new Error('兑现合同缺少 passed')
  const titlePromise = String(value.title_promise ?? '').trim()
  const hookPromise = String(value.hook_promise ?? '').trim()
  const firstThirtyPercentEvidence = stringList(value.first_thirty_percent_evidence)
  const climaxEvidence = stringList(value.climax_evidence)
  const endingEvidence = stringList(value.ending_evidence)
  const missingPromises = stringList(value.missing_promises)
  const claimedPassed = value.passed === true
  requireSourceEvidence(firstThirtyPercentEvidence, source.firstThirtyPercent, '前30%兑现', claimedPassed)
  requireSourceEvidence(climaxEvidence, source.climaxWindow, '高潮兑现', claimedPassed)
  requireSourceEvidence(endingEvidence, source.ending, '结局兑现', claimedPassed)
  if (!claimedPassed && missingPromises.length === 0) {
    throw new Error('兑现合同判定未通过但缺少 missing_promises')
  }
  const passed = value.passed
    && titlePromise.length > 0
    && hookPromise.length > 0
    && firstThirtyPercentEvidence.length > 0
    && climaxEvidence.length > 0
    && endingEvidence.length > 0
    && missingPromises.length === 0
  return {
    passed,
    titlePromise,
    hookPromise,
    firstThirtyPercentEvidence,
    climaxEvidence,
    endingEvidence,
    missingPromises
  }
}

export function validateStoryComplianceEvidence(
  value: Record<string, unknown>,
  fullBody: string
): StoryComplianceAssessment {
  if (typeof value.passed !== 'boolean') throw new Error('事实与平台门禁缺少 passed')
  const allowedDomains = new Set([
    'legal', 'medical', 'financial', 'privacy', 'cyberbullying', 'extreme_revenge', 'platform'
  ])
  const issues = Array.isArray(value.issues)
    ? value.issues.flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const row = raw as Record<string, unknown>
        const domain = String(row.domain ?? '')
        const code = String(row.code ?? '').trim()
        const evidence = String(row.evidence ?? '').trim()
        const message = String(row.message ?? '').trim()
        const requiredAction = String(row.required_action ?? '').trim()
        if (!allowedDomains.has(domain) || !code || !evidence || !message || !requiredAction) return []
        return [{
          code,
          domain: domain as StoryComplianceAssessment['issues'][number]['domain'],
          evidence,
          message,
          requiredAction
        }]
      }).slice(0, 20)
    : []
  for (const issue of issues) {
    requireSourceEvidence([issue.evidence], fullBody, `合规问题 ${issue.code}`)
  }
  if (value.passed === false && issues.length === 0) {
    throw new Error('合规门禁判定未通过但缺少可定位问题')
  }
  return { passed: value.passed && issues.length === 0, issues }
}

export async function assessStoryReleaseReview(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<StoryReleaseReview> {
  const evidence = storyEvidence(workId)
  onProgress?.('目标验收：正在核对标题、导语与正文兑现合同')
  const promise = await requestStructuredModelOutput<StoryReleasePromiseAssessment>({
    workId,
    label: '短故事发布兑现合同',
    signal,
    attempts: 2,
    validate: value => validateStoryReleasePromiseEvidence(value, evidence),
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_release_promise_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 1800,
        forceThinkingDisabled: true,
        systemPrompt: [
          '你是独立短故事发布主编，只做证据验收，不改写正文。',
          '标题承诺必须在正文形成真实、主要且可识别的事件结果；只出现同义词、威胁、设想或擦边结果不算兑现。',
          '导语承诺必须在前30%推进，在高潮改变胜负，在结局完成回收；四段证据必须来自提供的原文。',
          '任一标题核心结果未发生、导语悬念被绕开、高潮靠新事实解决、结局只口头宣告，passed=false。',
          '只输出 JSON：{"passed":false,"title_promise":"...","hook_promise":"...","first_thirty_percent_evidence":["原文证据"],"climax_evidence":["原文证据"],"ending_evidence":["原文证据"],"missing_promises":["未兑现项"]}'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goalDescription.trim() || '高完读率短故事'}`,
          `【标题】\n${evidence.title}`,
          `【导语】\n${evidence.hook}`,
          `【前30%】\n${evidence.firstThirtyPercent}`,
          `【高潮窗口】\n${evidence.climaxWindow}`,
          `【结局】\n${evidence.ending}`,
          attempt > 1 ? `【上一轮协议错误】${error}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
  })

  onProgress?.('目标验收：正在核对题材事实与番茄内容安全')
  const compliance = await requestStructuredModelOutput<StoryComplianceAssessment>({
    workId,
    label: '短故事事实与平台合规门禁',
    signal,
    attempts: 2,
    validate: value => validateStoryComplianceEvidence(
      value,
      [evidence.title, evidence.hook, evidence.fullBody].join('\n')
    ),
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_compliance_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 2200,
        forceThinkingDisabled: true,
        systemPrompt: [
          '你是独立短故事事实与平台安全编辑，只报告可定位的发布阻塞项，不润色、不重写。',
          '核对法律、医疗、金融程序与结果是否被写成确定事实；不确定或明显失真的专业结论必须阻塞。',
          '核对是否把曝光隐私、开盒、人肉、网暴、煽动围攻、极端报复写成可模仿的正当爽点。',
          '核对恶意羞辱、未成年人伤害、违法获证、巧合式官方处置与无依据职业/学籍处分。',
          '只有可引用原文证据的问题才能进入 issues；每项必须给出最小必要修正动作。',
          '只输出 JSON：{"passed":false,"issues":[{"code":"LEGAL_PROCESS_FALSE","domain":"legal","evidence":"原文短证据","message":"问题","required_action":"最小修正"}]}'
        ].join('\n'),
        prompt: [
          `【标题与导语】\n${evidence.title}\n${evidence.hook}`,
          `【完整正文】\n${evidence.fullBody}`,
          attempt > 1 ? `【上一轮协议错误】${error}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
  })

  const harnessIssues: StoryHarnessIssue[] = []
  if (!promise.passed) {
    harnessIssues.push({
      code: 'RELEASE_PROMISE_UNFULFILLED',
      severity: 'blocker',
      scope: 'engine',
      evidence: [
        `标题承诺：${promise.titlePromise || '未提取'}`,
        `导语承诺：${promise.hookPromise || '未提取'}`,
        ...promise.missingPromises
      ],
      message: '标题/导语/前30%/高潮/结局没有形成完整兑现链',
      expectedResult: '只修复缺失的承诺链；标题核心结果必须在正文中真实发生并在结局回收',
      invariants: ['未被缺失承诺点名的情节、人物状态与证据链保持不变']
    })
  }
  for (const issue of compliance.issues) {
    harnessIssues.push({
      code: `COMPLIANCE_${issue.code}`,
      severity: 'blocker',
      scope: 'engine',
      evidence: [issue.evidence],
      message: issue.message,
      expectedResult: issue.requiredAction,
      invariants: ['不得用更换专业名词掩盖同一事实错误或平台风险']
    })
  }
  return { promise, compliance, harnessIssues }
}
