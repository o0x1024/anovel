export const MODEL_CAPABILITY_UNSUPPORTED = 'MODEL_CAPABILITY_UNSUPPORTED'

const NATIVE_JSON_SCHEMA_UNAVAILABLE = [
  /response_format type is unavailable/i,
  /response_format[^.]*json_schema[^.]*not (?:available|supported)/i,
  /json_schema[^.]*not (?:available|supported)/i,
  /(?:unsupported|unavailable)[^.]*json_schema/i,
  /schema unsupported/i
]

export function isNativeJsonSchemaUnavailable(message: string): boolean {
  return NATIVE_JSON_SCHEMA_UNAVAILABLE.some(pattern => pattern.test(message))
}

export function nativeJsonSchemaCapabilityError(input: {
  modelName: string
  stepLabel: string
  upstreamMessage: string
}): string {
  return [
    `${MODEL_CAPABILITY_UNSUPPORTED}:`,
    `模型「${input.modelName}」不支持「${input.stepLabel}」要求的原生 JSON Schema`,
    '（response_format.type=json_schema）。',
    `请在“设置 → 模型分配”中为「${input.stepLabel}」选择支持原生 JSON Schema 的模型。`,
    `上游错误：${input.upstreamMessage}`
  ].join('')
}

export function isModelCapabilityUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(MODEL_CAPABILITY_UNSUPPORTED)
    || isNativeJsonSchemaUnavailable(message)
}
