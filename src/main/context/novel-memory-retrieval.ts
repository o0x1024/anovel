export interface StoryFactLike {
  chapter_id: number
  entity: string
  state_key: string
  value_json: string
  transition: string
  irreversible: number
  evidence: string | null
}

export interface TimelineEventLike {
  event_name: string
  event_description: string | null
  absolute_time: string | null
  relative_time: string | null
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

export function extractMemoryKeywords(text: string, limit = 18): string[] {
  const chinese = text.match(/[\p{Script=Han}]{2,8}/gu) ?? []
  const ascii = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,24}/g) ?? []
  const stop = new Set(['本章', '章节', '故事', '主角', '当前', '必须', '禁止', '进行', '已经', '一个', '之后', '然后'])
  const counts = new Map<string, number>()
  for (const value of [...chinese, ...ascii]) {
    if (stop.has(value)) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([value]) => value)
}

/**
 * 从全书状态账本中选择与当前章节相关的“最新事实”。
 * 角色/实体命中、不可逆事实和近期变化优先，最终仍按原始时序输出。
 */
export function selectRelevantStoryFacts<T extends StoryFactLike>(
  facts: T[],
  focusText: string,
  focusNames: string[],
  maxFacts = 48
): T[] {
  if (facts.length === 0 || maxFacts <= 0) return []
  const latestByKey = new Map<string, { fact: T; index: number }>()
  facts.forEach((fact, index) => {
    latestByKey.set(`${fact.entity.trim()}::${fact.state_key.trim()}`, { fact, index })
  })

  const focus = compactText(focusText)
  const names = focusNames.map(compactText).filter(Boolean)
  const keywords = extractMemoryKeywords(focusText)
  const rows = [...latestByKey.values()].map(row => {
    const entity = compactText(row.fact.entity)
    const stateKey = compactText(row.fact.state_key)
    const searchable = compactText([
      row.fact.entity,
      row.fact.state_key,
      row.fact.value_json,
      row.fact.evidence ?? ''
    ].join(' '))
    let score = 0
    if (entity && names.some(name => searchable.includes(name) || name.includes(entity))) score += 30
    if (entity && focus.includes(entity)) score += 18
    if (stateKey && focus.includes(stateKey)) score += 10
    score += Math.min(10, keywords.filter(keyword => searchable.includes(compactText(keyword))).length * 2)
    if (row.fact.irreversible) score += 8
    if (['complete', 'unlock', 'invalidate'].includes(row.fact.transition)) score += 4
    const recency = row.index / Math.max(1, facts.length - 1)
    score += Math.round(recency * 6)
    return { ...row, score }
  })

  // 即使没有关键词命中，也保留最近状态，避免新出现的承重事实立刻丢失。
  const recentIndexes = new Set(rows.slice(-12).map(row => row.index))
  return rows
    .filter(row => row.score > 6 || recentIndexes.has(row.index))
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, maxFacts)
    .sort((a, b) => a.index - b.index)
    .map(row => row.fact)
}

export function selectRelevantTimelineEvents<T extends TimelineEventLike>(
  events: T[],
  focusText: string,
  focusNames: string[],
  maxEvents = 20
): T[] {
  if (events.length === 0 || maxEvents <= 0) return []
  const focus = compactText(focusText)
  const names = focusNames.map(compactText).filter(Boolean)
  const keywords = extractMemoryKeywords(focusText)
  const recentStart = Math.max(0, events.length - 8)
  return events
    .map((event, index) => {
      const eventName = compactText(event.event_name)
      const searchable = compactText([
        event.event_name,
        event.event_description ?? '',
        event.absolute_time ?? '',
        event.relative_time ?? ''
      ].join(' '))
      let score = index >= recentStart ? 20 : 0
      if (index === 0) score += 4
      if (names.some(name => searchable.includes(name))) score += 18
      if (eventName && focus.includes(eventName)) score += 10
      score += Math.min(10, keywords.filter(keyword => searchable.includes(compactText(keyword))).length * 2)
      return { event, index, score }
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, maxEvents)
    .sort((a, b) => a.index - b.index)
    .map(row => row.event)
}
