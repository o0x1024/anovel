import type {
  NarrativeEntityKind,
  NarrativeState
} from './domain'
import { NarrativeKernelError } from './errors'

function normalizeEntityReference(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

function entityNames(canonicalName: string, aliases: string[]): string[] {
  return [canonicalName, ...aliases].map(normalizeEntityReference)
}

export function resolveNarrativeEntityId(
  state: NarrativeState,
  kind: NarrativeEntityKind,
  reference: string
): string {
  const normalized = normalizeEntityReference(reference)
  const matches = Object.values(
    kind === 'actor'
      ? state.actors
      : kind === 'location'
        ? state.locations
        : kind === 'artifact'
          ? state.artifacts
          : state.claims
  ).filter(entity => {
    if (kind === 'claim') {
      return normalizeEntityReference(entity.id) === normalized
    }
    return entityNames(entity.canonicalName, entity.aliases).includes(normalized)
  })

  if (matches.length === 0) {
    throw new NarrativeKernelError(
      'ENTITY_REFERENCE_UNKNOWN',
      `无法解析${kind}引用：${reference}`,
      { kind, reference }
    )
  }
  if (matches.length > 1) {
    throw new NarrativeKernelError(
      'ENTITY_REFERENCE_AMBIGUOUS',
      `${kind}引用命中多个实体：${reference}`,
      { kind, reference, entityIds: matches.map(entity => entity.id) }
    )
  }
  return matches[0].id
}
