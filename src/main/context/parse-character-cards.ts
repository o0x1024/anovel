import type { CharacterCard, CharacterRole } from './character-cards'

const ROLE_ALIASES: Record<string, CharacterRole> = {
  protagonist: 'protagonist',
  supporting: 'supporting',
  antagonist: 'antagonist',
  主角: 'protagonist',
  配角: 'supporting',
  反派: 'antagonist'
}

const DOCUMENT_HEADINGS = /^#?\s*角色人设卡片$/i

/** 从 AI 生成结果解析人设卡片（JSON 优先，Markdown 回退） */
export function parseCharacterCardsFromAi(content: string): CharacterCard[] {
  const fromJson = parseCharacterCardsFromJson(content)
  if (fromJson.length > 0) return fromJson

  const fromMarkdown = parseCharacterCardsFromMarkdown(content)
  if (fromMarkdown.length > 0) return fromMarkdown

  return []
}

function parseCharacterCardsFromJson(content: string): CharacterCard[] {
  const rawCandidates: string[] = []

  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    rawCandidates.push(match[1].trim())
  }

  const inlineMatch = content.match(/\{[\s\S]*"cards"\s*:\s*\[[\s\S]*?\]\s*\}/)
  if (inlineMatch) rawCandidates.push(inlineMatch[0])

  rawCandidates.push(content.trim())

  for (const raw of rawCandidates) {
    try {
      const parsed = JSON.parse(raw) as unknown
      const list = cardsFromParsed(parsed)
      if (list.length > 0) return list
    } catch {
      // try next candidate
    }
  }
  return []
}

function cardsFromParsed(parsed: unknown): CharacterCard[] {
  return extractCardsArray(parsed)
    .map(item => normalizeCharacterCard(item))
    .filter((c): c is CharacterCard => c !== null)
}

function extractCardsArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.cards)) return obj.cards
  if (Array.isArray(obj.characters)) return obj.characters
  return []
}

function normalizeCharacterCard(item: unknown): CharacterCard | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const name = String(row.name ?? row.character_name ?? row.角色名 ?? '').trim()
  if (!name) return null

  const rawRole = String(row.role ?? row.角色 ?? 'supporting').trim()
  const role = parseRole(rawRole)

  const reactionsRaw = row.reactions ?? row.行为反应
  let reactions: CharacterCard['reactions']
  if (reactionsRaw && typeof reactionsRaw === 'object') {
    const r = reactionsRaw as Record<string, unknown>
    reactions = {
      instinct: String(r.instinct ?? r.本能 ?? '').trim() || undefined,
      rational: String(r.rational ?? r.理性 ?? '').trim() || undefined,
      hidden: String(r.hidden ?? r.隐藏 ?? '').trim() || undefined
    }
  }

  const growthRaw = row.growthTriggers ?? row.成长触发点
  const growthTriggers = parseGrowthTriggers(growthRaw)

  return {
    name,
    role,
    memoryTag: String(row.memoryTag ?? row.memory_tag ?? row.记忆标签 ?? '').trim() || undefined,
    coreConflict: String(row.coreConflict ?? row.core_conflict ?? row.核心矛盾 ?? row.核心冲突 ?? '').trim() || undefined,
    reactions,
    speechStyle: String(row.speechStyle ?? row.speech_style ?? row.语言风格 ?? '').trim() || undefined,
    growthTriggers,
    relationBinding: String(row.relationBinding ?? row.relation_binding ?? row.关系绑定 ?? '').trim() || undefined
  }
}

function parseCharacterCardsFromMarkdown(content: string): CharacterCard[] {
  const body = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()
  const sections = body.split(/^##\s+/m).map(s => s.trim()).filter(Boolean)
  if (sections.length === 0) return []

  const cards: CharacterCard[] = []
  for (const section of sections) {
    const card = parseMarkdownSection(section)
    if (card) cards.push(card)
  }
  return cards
}

function parseMarkdownSection(section: string): CharacterCard | null {
  const lines = section.split('\n')
  const heading = lines[0]?.replace(/\*{2}/g, '').trim()
  if (!heading || DOCUMENT_HEADINGS.test(heading) || heading.startsWith('#')) return null

  const body = lines.slice(1).join('\n')
  const fields = parseMarkdownFields(body)

  const name = pickField(fields, ['姓名', 'name']) || heading
  if (!name || DOCUMENT_HEADINGS.test(name)) return null

  const reactionsBlock = pickField(fields, ['三层反应模式', '行为反应', 'reactions']) ?? ''
  const reactions = {
    instinct: extractReaction(reactionsBlock, ['本能反应', '本能', 'instinct']),
    rational: extractReaction(reactionsBlock, ['理性反应', '理性', 'rational']),
    hidden: extractReaction(reactionsBlock, ['隐藏反应', '隐藏', 'hidden'])
  }
  const hasReactions = reactions.instinct || reactions.rational || reactions.hidden

  const growthBlock = pickField(fields, ['成长弧线触发点', '成长触发点', 'growthTriggers']) ?? ''
  const growthTriggers = parseGrowthTriggersFromMarkdown(growthBlock)

  return {
    name,
    role: parseRole(pickField(fields, ['角色定位', '角色', 'role']) ?? ''),
    memoryTag: pickField(fields, ['记忆标签', 'memoryTag']),
    coreConflict: pickField(fields, ['核心冲突', '核心矛盾', 'coreConflict']),
    reactions: hasReactions ? reactions : undefined,
    speechStyle: pickField(fields, ['语言风格', 'speechStyle']),
    growthTriggers: growthTriggers.length > 0 ? growthTriggers : undefined,
    relationBinding: pickField(fields, ['关系绑定', 'relationBinding'])
  }
}

function parseMarkdownFields(section: string): Map<string, string> {
  const fields = new Map<string, string>()
  const fieldRegex = /(?:^|\n)\*{0,2}([^*\n]+)\*{0,2}[：:]\s*/g
  const matches = [...section.matchAll(fieldRegex)]

  for (let i = 0; i < matches.length; i++) {
    const label = matches[i][1].trim()
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? section.length) : section.length
    fields.set(label, section.slice(start, end).trim())
  }
  return fields
}

function pickField(fields: Map<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    const value = fields.get(label)?.trim()
    if (value) return value
  }
  return undefined
}

function extractReaction(block: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bullet = block.match(
      new RegExp(`[-*•]\\s*\\*{0,2}${escaped}\\*{0,2}[：:]\\s*(.+?)(?=\\n[-*•]|\\n\\*{2}|$)`, 's')
    )
    if (bullet?.[1]?.trim()) return bullet[1].trim()

    const inline = block.match(new RegExp(`\\*{0,2}${escaped}\\*{0,2}[：:]\\s*(.+?)(?=\\n[-*•]|\\n\\*{2}|$)`, 's'))
    if (inline?.[1]?.trim()) return inline[1].trim()
  }
  return undefined
}

function parseGrowthTriggersFromMarkdown(block: string): string[] {
  if (!block.trim()) return []

  const bullets = [...block.matchAll(/^[-*•]\s+(?:\*\*)?(?:\d+[.)]\s*)?(.+?)(?:\*\*)?\s*$/gm)]
    .map(m => m[1].replace(/\*{2}/g, '').trim())
    .filter(Boolean)

  if (bullets.length > 0) return bullets

  return parseGrowthTriggers(block) ?? []
}

function parseGrowthTriggers(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const list = raw.map(v => String(v).trim()).filter(Boolean)
    return list.length > 0 ? list : undefined
  }
  if (typeof raw === 'string' && raw.trim()) {
    const list = raw.split(/[；;,]/).map(s => s.trim()).filter(Boolean)
    return list.length > 0 ? list : undefined
  }
  return undefined
}

function parseRole(raw: string): CharacterRole {
  const normalized = raw.trim()
  const lower = normalized.toLowerCase()
  if (ROLE_ALIASES[normalized]) return ROLE_ALIASES[normalized]
  if (ROLE_ALIASES[lower]) return ROLE_ALIASES[lower]

  if (/protagonist|主角/i.test(normalized)) return 'protagonist'
  if (/antagonist|反派/i.test(normalized)) return 'antagonist'
  if (/supporting|配角/i.test(normalized)) return 'supporting'
  return 'supporting'
}
