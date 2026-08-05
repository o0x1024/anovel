import { createHash } from 'node:crypto'

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value))
}
