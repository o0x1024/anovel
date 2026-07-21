import { coreSettingDAO, volumeChapterDAO } from '../db'
import { loadWritingPlan } from './writing-plan'
import { loadCharacterCards, resolveChapterCharacterNames } from './character-cards'
import {
  buildChapterExecutionContract,
  type ChapterExecutionContract
} from '../../shared/chapter-execution-contract'

const SETTING_CHAR_BUDGETS: Record<string, number> = {
  golden_finger: 1400,
  world_pressure: 900,
  supporting_cast: 800
}

const SETTING_LABELS: Record<string, string> = {
  protagonist: '本章相关主角规则',
  golden_finger: '本章相关能力规则',
  world_pressure: '本章相关世界规则',
  conflict_engine: '本章相关冲突规则',
  pleasure_engine: '本章相关兑现规则',
  supporting_cast: '本章相关人物关系',
  main_plotline: '本章相关主线阶段'
}

const QUERY_STOPWORDS = new Set([
  '本章', '必须', '禁止', '当前', '一个', '这个', '那个', '进行', '已经', '没有', '不能',
  '人物', '角色', '情节', '状态', '目标', '要求', '正文', '章节', '系统', '时候', '开始'
])

function queryTerms(text: string, characterNames: string[]): string[] {
  const terms = new Set(characterNames)
  for (const match of text.match(/[\u4e00-\u9fff]{2,8}/g) ?? []) {
    if (match.length <= 4 && !QUERY_STOPWORDS.has(match)) terms.add(match)
    if (match.length > 4) {
      for (let i = 0; i <= match.length - 2; i += 2) {
        const part = match.slice(i, Math.min(match.length, i + 4))
        if (part.length >= 2 && !QUERY_STOPWORDS.has(part)) terms.add(part)
      }
    }
  }
  return [...terms].filter(Boolean).slice(0, 80)
}

function settingParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map(item => item.trim())
    .filter(item => item.length >= 8)
}

function paragraphAppliesToChapter(text: string, chapterOrdinal?: number): boolean {
  if (!chapterOrdinal || chapterOrdinal <= 0) return true
  const ranges = [...text.matchAll(/第\s*(\d+)\s*[-—~至到]\s*(\d+)\s*章/g)]
  if (ranges.length > 0) {
    return ranges.some(match => chapterOrdinal >= Number(match[1]) && chapterOrdinal <= Number(match[2]))
  }
  const singles = [...text.matchAll(/第\s*(\d+)\s*章/g)].map(match => Number(match[1]))
  if (singles.length === 0) return true
  return singles.some(value => Math.abs(value - chapterOrdinal) <= 2)
}

export function selectRelevantSettingExcerpts(
  content: string,
  terms: string[],
  maxChars: number,
  chapterOrdinal?: number
): string {
  const paragraphs = settingParagraphs(content).filter(text => paragraphAppliesToChapter(text, chapterOrdinal))
  if (paragraphs.length === 0) return content.trim().slice(0, maxChars)
  const ranked = paragraphs.map((text, index) => {
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? Math.min(4, term.length) : 0), 0)
    const ruleBoost = /核心|规则|限制|边界|红线|本能|语言|阶段/.test(text) ? 2 : 0
    return { text, index, score: score + ruleBoost }
  })
  const selected: Array<{ text: string; index: number }> = []
  let used = 0
  for (const item of ranked.sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (item.score <= 0 && selected.length > 0) continue
    const remaining = maxChars - used
    if (remaining < 80) break
    const text = item.text.length > remaining ? `${item.text.slice(0, Math.max(0, remaining - 1))}…` : item.text
    selected.push({ text, index: item.index })
    used += text.length + 2
  }
  return selected.sort((a, b) => a.index - b.index).map(item => item.text).join('\n\n').slice(0, maxChars)
}

export function compileChapterExecutionContract(
  workId: number,
  chapterId: number,
  wordTargetOverride?: number
): ChapterExecutionContract | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const chapter = chapters.find(item => item.id === chapterId)
  if (!chapter) return null
  const volume = volumeChapterDAO.listVolumes(workId).find(item => item.id === chapter.volume_id)
  const characterNames = resolveChapterCharacterNames(workId, chapter)
  const cards = loadCharacterCards(workId).filter(card => characterNames.includes(card.name))
  const wordTarget = wordTargetOverride ?? loadWritingPlan(workId).wordsPerChapter
  return buildChapterExecutionContract({
    chapterId,
    chapterTitle: chapter.title,
    chapterOrdinal: chapters.findIndex(item => item.id === chapterId) + 1,
    volumeName: volume?.name,
    volumeGoal: volume?.description?.slice(0, 800),
    outline: chapter.outline,
    outlineDiagnosis: chapter.outline_diagnosis,
    characterNames,
    characterSpeechStyles: cards.map(card => card.speechStyle ?? ''),
    wordTarget
  })
}

export function persistChapterExecutionContract(
  workId: number,
  chapterId: number,
  wordTargetOverride?: number
): ChapterExecutionContract | null {
  const contract = compileChapterExecutionContract(workId, chapterId, wordTargetOverride)
  if (!contract) return null
  const chapter = volumeChapterDAO.getChapter(chapterId)
  let diagnosis: Record<string, unknown> = {}
  let diagnosisReadable = true
  try {
    const parsed = chapter?.outline_diagnosis?.trim()
      ? JSON.parse(chapter.outline_diagnosis) as unknown
      : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      diagnosis = parsed as Record<string, unknown>
    }
  } catch { diagnosisReadable = false }
  if (!diagnosisReadable) return contract
  const current = diagnosis.execution_contract_v3 as {
    sourceOutlineHash?: unknown
    wordTarget?: unknown
  } | undefined
  if (current?.sourceOutlineHash !== contract.sourceOutlineHash || current?.wordTarget !== contract.wordTarget) {
    volumeChapterDAO.updateChapter(chapterId, {
      outline_diagnosis: JSON.stringify({ ...diagnosis, execution_contract_v3: contract }),
      quality_assessment_json: null
    })
  }
  return contract
}

export interface ChapterExecutionContextResult {
  text: string
  sectionChars: Record<string, number>
}

export function buildChapterExecutionContext(
  workId: number,
  chapterId: number,
  contract: ChapterExecutionContract
): ChapterExecutionContextResult {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const query = [chapter?.title, chapter?.outline, contract.characterNames.join('、')].filter(Boolean).join('\n')
  const terms = queryTerms(query, contract.characterNames)
  const settings = coreSettingDAO.listByWork(workId)
  const sections: string[] = []
  const sectionChars: Record<string, number> = {}

  for (const [type, maxChars] of Object.entries(SETTING_CHAR_BUDGETS)) {
    const raw = settings.find(item => item.type === type)?.content?.trim()
    if (!raw) continue
    const excerpt = selectRelevantSettingExcerpts(raw, terms, maxChars, contract.chapterOrdinal)
    if (!excerpt) continue
    const label = SETTING_LABELS[type] ?? type
    sections.push(`## ${label}\n${excerpt}`)
    sectionChars[type] = excerpt.length
  }

  const text = sections.length > 0
    ? ['【本章相关设定摘录 - 仅用于事实一致性，章节合同优先】', ...sections].join('\n\n')
    : ''
  return { text, sectionChars }
}
