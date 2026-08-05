export interface PromptJsonSchema {
  name: string
  schema: Record<string, unknown>
}

export function buildPromptJsonSchemaInstruction(responseSchema: PromptJsonSchema): string {
  return [
    '【JSON 输出协议】',
    '只输出一个完整 JSON 对象，不要输出 Markdown 代码块、解释、前后缀或思考过程。',
    `输出对象必须符合以下 ${responseSchema.name} Schema：`,
    JSON.stringify(responseSchema.schema),
    '若内容较长，优先压缩字符串字段，但不得缺少 required 字段，不得截断 JSON。'
  ].join('\n')
}
