import {
  createNarrativePatch,
  type CandidateEvidenceSpan,
  type NarrativePatch,
  type ProposedNarrativeEvent
} from './chapter-contracts'
import type { ArtifactHolder, ArtifactProvenance } from './domain'
import { NarrativeKernelError } from './errors'

type JsonObject = Record<string, unknown>

function invalid(path: string, message: string): never {
  throw new NarrativeKernelError(
    'NARRATIVE_PATCH_INVALID',
    `${path}: ${message}`,
    { path }
  )
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(path, '必须是对象')
  }
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const expected = new Set(keys)
  const unexpected = Object.keys(value).filter(key => !expected.has(key))
  if (unexpected.length > 0) {
    invalid(path, `包含未声明字段：${unexpected.join(', ')}`)
  }
  const missing = keys.filter(key => !(key in value))
  if (missing.length > 0) {
    invalid(path, `缺少字段：${missing.join(', ')}`)
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(path, '必须是非空字符串')
  }
  return value
}

function integerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    return invalid(path, `必须是大于等于 ${minimum} 的整数`)
  }
  return value as number
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return invalid(path, '必须是字符串数组')
  return value.map((item, index) => stringAt(item, `${path}[${index}]`))
}

function enumAt<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalid(path, `必须是以下值之一：${allowed.join(', ')}`)
  }
  return value as T
}

function parseEvidence(value: unknown, path: string): CandidateEvidenceSpan {
  const object = objectAt(value, path)
  exactKeys(object, ['candidateId', 'startOffset', 'endOffset', 'quoteHash'], path)
  const quoteHash = stringAt(object.quoteHash, `${path}.quoteHash`)
  if (!/^[a-f0-9]{64}$/.test(quoteHash)) {
    invalid(`${path}.quoteHash`, '必须是小写 SHA-256 哈希')
  }
  return {
    candidateId: stringAt(object.candidateId, `${path}.candidateId`),
    startOffset: integerAt(object.startOffset, `${path}.startOffset`),
    endOffset: integerAt(object.endOffset, `${path}.endOffset`, 1),
    quoteHash
  }
}

function parseHolder(value: unknown, path: string): ArtifactHolder {
  const object = objectAt(value, path)
  const kind = enumAt(object.kind, ['actor', 'location'] as const, `${path}.kind`)
  if (kind === 'actor') {
    exactKeys(object, ['kind', 'actorId'], path)
    return { kind, actorId: stringAt(object.actorId, `${path}.actorId`) }
  }
  exactKeys(object, ['kind', 'locationId'], path)
  return { kind, locationId: stringAt(object.locationId, `${path}.locationId`) }
}

function parseProvenance(value: unknown, path: string): ArtifactProvenance {
  const object = objectAt(value, path)
  exactKeys(object, ['kind', 'sourceEntityId'], path)
  return {
    kind: enumAt(
      object.kind,
      ['created', 'found', 'inherited', 'purchased', 'stolen'] as const,
      `${path}.kind`
    ),
    sourceEntityId: stringAt(object.sourceEntityId, `${path}.sourceEntityId`)
  }
}

function baseEvent(value: JsonObject, path: string): {
  id: string
  chapterOrdinal: number
  evidence: CandidateEvidenceSpan
} {
  return {
    id: stringAt(value.id, `${path}.id`),
    chapterOrdinal: integerAt(value.chapterOrdinal, `${path}.chapterOrdinal`, 1),
    evidence: parseEvidence(value.evidence, `${path}.evidence`)
  }
}

function parseEvent(value: unknown, index: number): ProposedNarrativeEvent {
  const path = `$.events[${index}]`
  const object = objectAt(value, path)
  const type = stringAt(object.type, `${path}.type`)
  const baseKeys = ['id', 'type', 'chapterOrdinal', 'evidence'] as const
  const base = baseEvent(object, path)

  switch (type) {
    case 'ActorIntroduced':
      exactKeys(object, [...baseKeys, 'actorId', 'canonicalName', 'aliases'], path)
      return {
        ...base,
        type,
        actorId: stringAt(object.actorId, `${path}.actorId`),
        canonicalName: stringAt(object.canonicalName, `${path}.canonicalName`),
        aliases: stringArrayAt(object.aliases, `${path}.aliases`)
      }
    case 'LocationIntroduced':
      exactKeys(object, [...baseKeys, 'locationId', 'canonicalName', 'aliases'], path)
      return {
        ...base,
        type,
        locationId: stringAt(object.locationId, `${path}.locationId`),
        canonicalName: stringAt(object.canonicalName, `${path}.canonicalName`),
        aliases: stringArrayAt(object.aliases, `${path}.aliases`)
      }
    case 'ArtifactIntroduced':
      exactKeys(
        object,
        [...baseKeys, 'artifactId', 'canonicalName', 'aliases', 'provenance', 'holder', 'quantity'],
        path
      )
      return {
        ...base,
        type,
        artifactId: stringAt(object.artifactId, `${path}.artifactId`),
        canonicalName: stringAt(object.canonicalName, `${path}.canonicalName`),
        aliases: stringArrayAt(object.aliases, `${path}.aliases`),
        provenance: parseProvenance(object.provenance, `${path}.provenance`),
        holder: parseHolder(object.holder, `${path}.holder`),
        quantity: integerAt(object.quantity, `${path}.quantity`, 1)
      }
    case 'ArtifactTransferred':
      exactKeys(object, [...baseKeys, 'artifactId', 'from', 'to'], path)
      return {
        ...base,
        type,
        artifactId: stringAt(object.artifactId, `${path}.artifactId`),
        from: parseHolder(object.from, `${path}.from`),
        to: parseHolder(object.to, `${path}.to`)
      }
    case 'ArtifactUsed':
      exactKeys(object, [...baseKeys, 'artifactId', 'actorId', 'action'], path)
      return {
        ...base,
        type,
        artifactId: stringAt(object.artifactId, `${path}.artifactId`),
        actorId: stringAt(object.actorId, `${path}.actorId`),
        action: stringAt(object.action, `${path}.action`)
      }
    case 'ArtifactConsumed':
      exactKeys(object, [...baseKeys, 'artifactId', 'actorId', 'quantity'], path)
      return {
        ...base,
        type,
        artifactId: stringAt(object.artifactId, `${path}.artifactId`),
        actorId: stringAt(object.actorId, `${path}.actorId`),
        quantity: integerAt(object.quantity, `${path}.quantity`, 1)
      }
    case 'ClaimEstablished':
      exactKeys(
        object,
        [...baseKeys, 'claimId', 'subjectEntityId', 'predicate', 'objectValue', 'truthStatus'],
        path
      )
      return {
        ...base,
        type,
        claimId: stringAt(object.claimId, `${path}.claimId`),
        subjectEntityId: stringAt(object.subjectEntityId, `${path}.subjectEntityId`),
        predicate: stringAt(object.predicate, `${path}.predicate`),
        objectValue: stringAt(object.objectValue, `${path}.objectValue`),
        truthStatus: enumAt(object.truthStatus, ['true', 'false'] as const, `${path}.truthStatus`)
      }
    case 'ActorLearnedClaim':
      exactKeys(object, [...baseKeys, 'actorId', 'claimId', 'belief'], path)
      return {
        ...base,
        type,
        actorId: stringAt(object.actorId, `${path}.actorId`),
        claimId: stringAt(object.claimId, `${path}.claimId`),
        belief: enumAt(
          object.belief,
          ['knows', 'believes', 'suspects', 'disbelieves'] as const,
          `${path}.belief`
        )
      }
    case 'ActorActedOnClaim':
      exactKeys(object, [...baseKeys, 'actorId', 'claimId', 'action'], path)
      return {
        ...base,
        type,
        actorId: stringAt(object.actorId, `${path}.actorId`),
        claimId: stringAt(object.claimId, `${path}.claimId`),
        action: stringAt(object.action, `${path}.action`)
      }
    default:
      return invalid(`${path}.type`, `不支持的叙事事件：${type}`)
  }
}

export function parseNarrativePatch(value: unknown): NarrativePatch {
  const object = objectAt(value, '$')
  exactKeys(object, ['id', 'intentId', 'candidateId', 'baseStateRevision', 'events'], '$')
  if (!Array.isArray(object.events)) invalid('$.events', '必须是数组')
  return createNarrativePatch({
    id: stringAt(object.id, '$.id'),
    intentId: stringAt(object.intentId, '$.intentId'),
    candidateId: stringAt(object.candidateId, '$.candidateId'),
    baseStateRevision: integerAt(object.baseStateRevision, '$.baseStateRevision'),
    events: object.events.map(parseEvent)
  })
}
