import type { ChapterCandidate, ChapterIntent } from '../chapter-contracts'
import type { NarrativeState } from '../domain'
import { canonicalJson } from '../hash'
import type { NarrativeModelRequest, NarrativeModelTask } from './model-contract'

export const NARRATIVE_PROMPT_PROTOCOL_VERSION = 1

export interface NarrativeTaskPrompt {
  systemPrompt: string
  prompt: string
  maxTokens: number
  temperature: number
}

function systemPrompt(task: NarrativeModelTask, instruction: string): string {
  return [
    `ANOVEL_TASK=${task}`,
    `ANOVEL_PROMPT_PROTOCOL=${NARRATIVE_PROMPT_PROTOCOL_VERSION}`,
    '你是自动化长篇小说流水线中的受约束执行器。',
    '只能完成当前任务，不得修改、忽略或重新解释输入合同。',
    instruction
  ].join('\n')
}

function bodyPrompt(input: Readonly<Record<string, unknown>>, revision: boolean): NarrativeTaskPrompt {
  const intent = input.intent as ChapterIntent
  const maxTokens = Math.max(2048, Math.ceil(intent.targetWordRange.max * 2.2))
  return {
    systemPrompt: systemPrompt(
      revision ? 'chapter_revision' : 'chapter_body',
      '只输出小说正文，不输出标题、分析、解释、Markdown 围栏或 JSON。'
    ),
    prompt: [
      revision ? '请严格按修订原因改写候选正文。' : '请根据章节契约生成完整正文。',
      '输入合同：',
      canonicalJson(input)
    ].join('\n'),
    maxTokens,
    temperature: revision ? 0.65 : 0.8
  }
}

function novelBlueprintPrompt(input: Readonly<Record<string, unknown>>): NarrativeTaskPrompt {
  return {
    systemPrompt: systemPrompt(
      'novel_blueprint',
      [
        '只输出一个 JSON 对象，不得输出 Markdown 围栏或解释。',
        '字段必须且只能是 title,premise,storyArc,chapterStrategy。',
        'chapterStrategy 必须是紧凑的长篇章节推进策略，说明开端、升级、中段、高潮、收束的节奏。',
        '不得列出全部章节，不得生成正文；后续每章会依据权威状态动态规划。'
      ].join('\n')
    ),
    prompt: ['请为这部小说建立完整且可执行的全书蓝图。', '输入合同：', canonicalJson(input)].join('\n'),
    maxTokens: 12000,
    temperature: 0.35
  }
}

function chapterIntentPrompt(input: Readonly<Record<string, unknown>>): NarrativeTaskPrompt {
  return {
    systemPrompt: systemPrompt(
      'chapter_intent',
      [
        '只输出一个 JSON 对象，不得输出 Markdown 围栏或解释。',
        '字段必须且只能是 objective,requiredEvents,forbiddenEvents,allowedEntityIds,creatableEntityIds。',
        'objective 必须只描述当前一章的可验证叙事目标。',
        'allowedEntityIds 只能引用输入权威状态已有实体 ID。',
        'creatableEntityIds 只能声明本章新实体 ID，且不得与既有实体重复。',
        'requiredEvents 与 forbiddenEvents 必须是数组；每个数组元素必须是 JSON 对象，绝不能是字符串、数组或事件名称。',
        'requiredEvents 元素只能是 {"eventType":"ActorIntroduced","minCount":1}，或 {"eventType":"ArtifactIntroduced","entityId":"artifact-id","minCount":1} 这种对象。',
        'forbiddenEvents 元素只能是 {"eventType":"ArtifactUsed"}，或 {"eventType":"ArtifactUsed","entityId":"artifact-id"} 这种对象。',
        'eventType 只能是 ActorIntroduced、LocationIntroduced、ArtifactIntroduced、ArtifactTransferred、ArtifactUsed、ArtifactConsumed、ClaimEstablished、ActorLearnedClaim、ActorActedOnClaim 之一。',
        '无法可靠约束时 requiredEvents 与 forbiddenEvents 都输出空数组。',
        '正确输出示例：{"objective":"主角在废墟中找到徽章","requiredEvents":[{"eventType":"ArtifactIntroduced","entityId":"artifact-badge","minCount":1}],"forbiddenEvents":[],"allowedEntityIds":[],"creatableEntityIds":["artifact-badge"]}'
      ].join('\n')
    ),
    prompt: ['请根据全书蓝图、当前章节计划和权威状态生成下一章契约。', '输入合同：', canonicalJson(input)].join('\n'),
    maxTokens: 5000,
    temperature: 0.1
  }
}

function patchPrompt(input: Readonly<Record<string, unknown>>): NarrativeTaskPrompt {
  return {
    systemPrompt: systemPrompt(
      'narrative_patch',
      [
        '只输出一个 JSON 对象，不得输出 Markdown 围栏或解释。',
        '顶层字段必须且只能是 id,intentId,candidateId,baseStateRevision,events。',
        '每个事件必须使用输入中已有或章节契约授权创建的实体 ID。',
        '事件证据字段使用 evidenceQuote，值必须是候选正文中唯一出现的连续原文。',
        '禁止输出 offset、quoteHash 或猜测性来源；这些由本地程序计算。'
      ].join('\n')
    ),
    prompt: [
      '请抽取足以重建本章状态变化的最小事件集合。',
      '支持的事件类型：ActorIntroduced, LocationIntroduced, ArtifactIntroduced,',
      'ArtifactTransferred, ArtifactUsed, ArtifactConsumed, ClaimEstablished,',
      'ActorLearnedClaim, ActorActedOnClaim。',
      '输入合同：',
      canonicalJson(input)
    ].join('\n'),
    maxTokens: 6000,
    temperature: 0.1
  }
}

function editorialPrompt(input: Readonly<Record<string, unknown>>): NarrativeTaskPrompt {
  return {
    systemPrompt: systemPrompt(
      'editorial_gate',
      [
        '只输出一个 JSON 对象，不得输出 Markdown 围栏或解释。',
        '字段必须且只能是 status,score,report,evidenceQuotes。',
        'status 只能是 passed 或 failed；score 为 0 到 100。',
        'evidenceQuotes 必须非空，每项必须是候选正文中唯一出现的连续原文。'
      ].join('\n')
    ),
    prompt: [
      '只评估输入指定的一个文学门，不得替其他门做结论。',
      '输入合同：',
      canonicalJson(input)
    ].join('\n'),
    maxTokens: 1600,
    temperature: 0.1
  }
}

export function buildNarrativeTaskPrompt(request: NarrativeModelRequest): NarrativeTaskPrompt {
  switch (request.task) {
    case 'novel_blueprint': return novelBlueprintPrompt(request.input)
    case 'chapter_intent': return chapterIntentPrompt(request.input)
    case 'chapter_body': return bodyPrompt(request.input, false)
    case 'chapter_revision': return bodyPrompt(request.input, true)
    case 'narrative_patch': return patchPrompt(request.input)
    case 'editorial_gate': return editorialPrompt(request.input)
  }
}

export type NarrativePromptInput = {
  intent: ChapterIntent
  state?: NarrativeState
  candidate?: ChapterCandidate
}
