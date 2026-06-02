export const WRITER_BLOCK_PROMPTS = {
  randomInspiration: '给作者一条随机的创作灵感提示（一句话画面、角色概念或情节念头），50字以内，直接输出灵感本身。',
  plotDirections: [
    '基于当前作品上下文，给出5个不同的情节走向建议，每个一行，编号1-5。',
    '输出 JSON：{"directions":["走向1","走向2","走向3","走向4","走向5"]}'
  ].join('\n'),
  characterWhatIf: '基于作品人设，提出3个「如果……会怎样」的思维实验，帮助突破写作障碍。每个50字以内，JSON：{"experiments":["...","...","..."]}',
  revisionChecklist: '对给定章节正文执行改文自检：定位问题、分类（微调/段落/章节/结构级）、独立章节评估、陌生读者视角评分。输出 Markdown 报告。'
} as const

export function parseDirections(content: string): string[] {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  try {
    const parsed = JSON.parse(match?.[1] ?? content) as { directions?: string[]; experiments?: string[] }
    return parsed.directions ?? parsed.experiments ?? []
  } catch {
    return content.split('\n').map(s => s.replace(/^\d+[\.\)、]\s*/, '').trim()).filter(Boolean).slice(0, 5)
  }
}
