import type { ChapterIntentInput, EventProhibition, EventRequirement } from '../chapter-contracts'
import { NarrativeKernelError } from '../errors'
import { canonicalHash } from '../hash'

type JsonObject = Record<string, unknown>

const EVENT_TYPES = [
  'ActorIntroduced', 'LocationIntroduced', 'ArtifactIntroduced', 'ArtifactTransferred',
  'ArtifactUsed', 'ArtifactConsumed', 'ClaimEstablished', 'ActorLearnedClaim', 'ActorActedOnClaim'
] as const

export interface AutoNovelBlueprint {
  title: string
  premise: string
  storyArc: string
  chapterStrategy: string
  blueprintHash: string
}

export interface AutoChapterIntentPlan {
  objective: string
  requiredEvents: EventRequirement[]
  forbiddenEvents: EventProhibition[]
  allowedEntityIds: string[]
  creatableEntityIds: string[]
}

function invalid(message: string): never {
  throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', `自动全书规划输出无效：${message}`)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} 必须是对象`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(value).filter(key => !allowed.has(key))
  const missing = keys.filter(key => !(key in value))
  if (unexpected.length > 0) invalid(`${path} 包含未声明字段：${unexpected.join(', ')}`)
  if (missing.length > 0) invalid(`${path} 缺少字段：${missing.join(', ')}`)
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${path} 必须是非空字符串`)
  return value.trim()
}

function ids(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} 必须是数组`)
  const values = value.map((item, index) => text(item, `${path}[${index}]`))
  if (new Set(values).size !== values.length) invalid(`${path} 包含重复实体 ID`)
  return values
}

function eventType(value: unknown, path: string): EventRequirement['eventType'] {
  if (typeof value !== 'string' || !EVENT_TYPES.includes(value as typeof EVENT_TYPES[number])) {
    invalid(`${path} 不是受支持的叙事事件类型`)
  }
  return value as EventRequirement['eventType']
}

function eventRequirements(value: unknown, path: string): EventRequirement[] {
  if (!Array.isArray(value)) invalid(`${path} 必须是数组`)
  return value.map((item, index) => {
    const record = objectAt(item, `${path}[${index}]`)
    const keys = 'entityId' in record
      ? ['eventType', 'entityId', 'minCount'] as const
      : ['eventType', 'minCount'] as const
    exactKeys(record, keys, `${path}[${index}]`)
    if (!Number.isInteger(record.minCount) || (record.minCount as number) <= 0) {
      invalid(`${path}[${index}].minCount 必须是正整数`)
    }
    return {
      eventType: eventType(record.eventType, `${path}[${index}].eventType`),
      ...(record.entityId == null ? {} : { entityId: text(record.entityId, `${path}[${index}].entityId`) }),
      minCount: record.minCount as number
    }
  })
}

function eventProhibitions(value: unknown, path: string): EventProhibition[] {
  if (!Array.isArray(value)) invalid(`${path} 必须是数组`)
  return value.map((item, index) => {
    const record = objectAt(item, `${path}[${index}]`)
    const keys = 'entityId' in record
      ? ['eventType', 'entityId'] as const
      : ['eventType'] as const
    exactKeys(record, keys, `${path}[${index}]`)
    return {
      eventType: eventType(record.eventType, `${path}[${index}].eventType`),
      ...(record.entityId == null ? {} : { entityId: text(record.entityId, `${path}[${index}].entityId`) })
    }
  })
}

export function parseAutoNovelBlueprint(value: unknown, targetChapters: number): AutoNovelBlueprint {
  const root = objectAt(value, '$')
  exactKeys(root, ['title', 'premise', 'storyArc', 'chapterStrategy'], '$')
  if (!Number.isInteger(targetChapters) || targetChapters <= 0) invalid('目标章节数必须是正整数')
  const payload = {
    title: text(root.title, '$.title'),
    premise: text(root.premise, '$.premise'),
    storyArc: text(root.storyArc, '$.storyArc'),
    chapterStrategy: text(root.chapterStrategy, '$.chapterStrategy')
  }
  return { ...payload, blueprintHash: canonicalHash(payload) }
}

export function parseAutoChapterIntentPlan(value: unknown): AutoChapterIntentPlan {
  const root = objectAt(value, '$')
  exactKeys(root, [
    'objective', 'requiredEvents', 'forbiddenEvents', 'allowedEntityIds', 'creatableEntityIds'
  ], '$')
  const allowedEntityIds = ids(root.allowedEntityIds, '$.allowedEntityIds')
  const creatableEntityIds = ids(root.creatableEntityIds, '$.creatableEntityIds')
  const overlap = allowedEntityIds.filter(id => creatableEntityIds.includes(id))
  if (overlap.length > 0) invalid(`实体不能同时引用和创建：${overlap.join(', ')}`)
  return {
    objective: text(root.objective, '$.objective'),
    requiredEvents: eventRequirements(root.requiredEvents, '$.requiredEvents'),
    forbiddenEvents: eventProhibitions(root.forbiddenEvents, '$.forbiddenEvents'),
    allowedEntityIds,
    creatableEntityIds
  }
}

export function materializeAutoChapterIntent(input: {
  id: string
  workId: number
  chapterOrdinal: number
  baseStateRevision: number
  wordRange: { min: number; max: number }
  plan: AutoChapterIntentPlan
}): ChapterIntentInput {
  return {
    id: input.id,
    workId: input.workId,
    chapterOrdinal: input.chapterOrdinal,
    baseStateRevision: input.baseStateRevision,
    objective: input.plan.objective,
    requiredEvents: input.plan.requiredEvents,
    forbiddenEvents: input.plan.forbiddenEvents,
    allowedEntityIds: input.plan.allowedEntityIds,
    creatableEntityIds: input.plan.creatableEntityIds,
    targetWordRange: input.wordRange
  }
}
