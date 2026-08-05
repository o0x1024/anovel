export class PromptJsonSchemaValidationError extends Error {
  readonly code = 'PROMPT_JSON_SCHEMA_INVALID'

  constructor(
    public readonly path: string,
    message: string,
    public readonly issue?: {
      kind: 'const' | 'enum' | 'type' | 'cardinality' | 'required' | 'additional' | 'pattern' | 'range' | 'union'
      actual?: unknown
      allowed?: unknown[]
    }
  ) {
    super(`${path || '$'} ${message}`)
    this.name = 'PromptJsonSchemaValidationError'
  }
}

export function formatPromptJsonSchemaIssueValue(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value)
  return (serialized === undefined ? String(value) : serialized).slice(0, maxChars)
}

type JsonSchema = Record<string, unknown>

function fail(
  path: string,
  message: string,
  issue?: PromptJsonSchemaValidationError['issue']
): never {
  throw new PromptJsonSchemaValidationError(path, message, issue)
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function validateNode(value: unknown, schema: JsonSchema, path: string): void {
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) {
    fail(path, '不等于协议规定的常量', {
      kind: 'const', actual: value, allowed: [schema.const]
    })
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    fail(path, '不在允许枚举中', {
      kind: 'enum', actual: value, allowed: schema.enum
    })
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf as JsonSchema[]) validateNode(value, branch, path)
  }
  if (Array.isArray(schema.anyOf)) {
    let matches = 0
    for (const branch of schema.anyOf as JsonSchema[]) {
      try {
        validateNode(value, branch, path)
        matches++
      } catch (error) {
        if (!(error instanceof PromptJsonSchemaValidationError)) throw error
      }
    }
    if (matches === 0) fail(path, '必须匹配 anyOf 的至少一个分支', { kind: 'union', actual: value })
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf as JsonSchema[]) {
      try {
        validateNode(value, branch, path)
        matches++
      } catch (error) {
        if (!(error instanceof PromptJsonSchemaValidationError)) throw error
      }
    }
    if (matches !== 1) fail(path, `必须且只能匹配 oneOf 的一个分支，实际匹配 ${matches} 个`, {
      kind: 'union', actual: value
    })
  }

  const expected = schema.type
  if (Array.isArray(expected)) {
    const failures: string[] = []
    for (const branchType of expected) {
      try {
        validateNode(value, { ...schema, type: branchType }, path)
        return
      } catch (error) {
        if (!(error instanceof PromptJsonSchemaValidationError)) throw error
        failures.push(error.message)
      }
    }
    fail(path, `必须匹配类型 ${expected.join(' | ')}；${failures.join('；')}`, {
      kind: 'type', actual: value, allowed: expected
    })
  }
  if (expected === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(path, `必须是 object，实际为 ${valueType(value)}`, { kind: 'type', actual: value, allowed: ['object'] })
    }
    const record = value as Record<string, unknown>
    const propertyCount = Object.keys(record).length
    if (typeof schema.minProperties === 'number' && propertyCount < schema.minProperties) {
      fail(path, `至少需要 ${schema.minProperties} 个字段`)
    }
    if (typeof schema.maxProperties === 'number' && propertyCount > schema.maxProperties) {
      fail(path, `最多允许 ${schema.maxProperties} 个字段`)
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${path}.${key}`, '缺少必需字段', { kind: 'required' })
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(record).find(key => !Object.prototype.hasOwnProperty.call(properties, key))
      if (unknown) fail(`${path}.${unknown}`, '是不允许的额外字段', {
        kind: 'additional', actual: record[unknown], allowed: Object.keys(properties)
      })
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        validateNode(record[key], childSchema, `${path}.${key}`)
      }
    }
    return
  }
  if (expected === 'array') {
    if (!Array.isArray(value)) fail(path, `必须是 array，实际为 ${valueType(value)}`, { kind: 'type', actual: value, allowed: ['array'] })
    const items = value as unknown[]
    if (typeof schema.minItems === 'number' && items.length < schema.minItems) {
      fail(path, `至少需要 ${schema.minItems} 项，实际为 ${items.length} 项`, {
        kind: 'cardinality', actual: items.length, allowed: [schema.minItems, schema.maxItems]
      })
    }
    if (typeof schema.maxItems === 'number' && items.length > schema.maxItems) {
      fail(path, `最多允许 ${schema.maxItems} 项，实际为 ${items.length} 项`, {
        kind: 'cardinality', actual: items.length, allowed: [schema.minItems, schema.maxItems]
      })
    }
    if (schema.uniqueItems === true) {
      const identities = items.map(item => JSON.stringify(item))
      if (new Set(identities).size !== identities.length) fail(path, '数组元素必须唯一')
    }
    if (schema.items && typeof schema.items === 'object') {
      items.forEach((item, index) => validateNode(item, schema.items as JsonSchema, `${path}[${index}]`))
    }
    return
  }
  if (expected === 'string') {
    if (typeof value !== 'string') fail(path, `必须是 string，实际为 ${valueType(value)}`, { kind: 'type', actual: value, allowed: ['string'] })
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(path, `长度至少为 ${schema.minLength}`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(path, `长度最多为 ${schema.maxLength}`)
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      fail(path, `不匹配规定格式 ${schema.pattern}`, { kind: 'pattern', actual: value, allowed: [schema.pattern] })
    }
    return
  }
  if (expected === 'integer') {
    if (!Number.isInteger(value)) fail(path, `必须是 integer，实际为 ${valueType(value)}`)
  } else if (expected === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `必须是有限 number`)
  } else if (expected === 'boolean' && typeof value !== 'boolean') {
    fail(path, `必须是 boolean，实际为 ${valueType(value)}`)
  } else if (expected === 'null' && value !== null) {
    fail(path, `必须是 null，实际为 ${valueType(value)}`)
  }
  if ((expected === 'integer' || expected === 'number') && typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(path, `不得小于 ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(path, `不得大于 ${schema.maximum}`)
  }
}

/** prompt_json 不受提供方原生 Schema 约束，解析后必须在本地执行同一协议。 */
export function validatePromptJsonSchema(value: unknown, schema: JsonSchema): void {
  validateNode(value, schema, '$')
}
