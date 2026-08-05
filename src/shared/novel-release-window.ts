import { createHash } from 'node:crypto'

export const NOVEL_RELEASE_WINDOW_PROTOCOL_VERSION = 1
export const NOVEL_RELEASE_WINDOW_SIZE = 8
export const NOVEL_RELEASE_MIN_SCORE = 75
export const NOVEL_RELEASE_CONTINUITY_MIN = 85
export const NOVEL_RELEASE_HOOK_MIN = 75
export const NOVEL_RELEASE_PROSE_MIN = 70

export interface NovelReleaseWindowChapter {
  id: number
  title: string
  content?: string | null
  status?: string | null
}

export interface NovelReleaseDimensionScores {
  continuity: number
  structure: number
  hook: number
  escalationPayoff: number
  characterEmotion: number
  proseRepetition: number
  settingNovelty: number
}

export interface NovelReleaseScore extends NovelReleaseDimensionScores {
  overall: number
}

export interface NovelReleaseWindowRange {
  startIndex: number
  endIndex: number
  startChapterId: number
  endChapterId: number
  chapters: NovelReleaseWindowChapter[]
  sourceHash: string
}

const clamp = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0
}

export function calculateNovelReleaseScore(
  input: NovelReleaseDimensionScores
): NovelReleaseScore {
  const scores: NovelReleaseDimensionScores = {
    continuity: clamp(input.continuity),
    structure: clamp(input.structure),
    hook: clamp(input.hook),
    escalationPayoff: clamp(input.escalationPayoff),
    characterEmotion: clamp(input.characterEmotion),
    proseRepetition: clamp(input.proseRepetition),
    settingNovelty: clamp(input.settingNovelty)
  }
  return {
    ...scores,
    overall: Math.round(
      scores.continuity * 0.20
      + scores.structure * 0.15
      + scores.hook * 0.15
      + scores.escalationPayoff * 0.15
      + scores.characterEmotion * 0.15
      + scores.proseRepetition * 0.10
      + scores.settingNovelty * 0.10
    )
  }
}

export function novelReleaseScoreBlockers(score: NovelReleaseScore): string[] {
  const blockers: string[] = []
  if (score.overall < NOVEL_RELEASE_MIN_SCORE) {
    blockers.push(`首发窗口综合分 ${score.overall} 低于发布线 ${NOVEL_RELEASE_MIN_SCORE}`)
  }
  if (score.continuity < NOVEL_RELEASE_CONTINUITY_MIN) {
    blockers.push(`连续性 ${score.continuity} 低于硬线 ${NOVEL_RELEASE_CONTINUITY_MIN}`)
  }
  if (score.hook < NOVEL_RELEASE_HOOK_MIN) {
    blockers.push(`追读钩子 ${score.hook} 低于硬线 ${NOVEL_RELEASE_HOOK_MIN}`)
  }
  if (score.proseRepetition < NOVEL_RELEASE_PROSE_MIN) {
    blockers.push(`文本可读性与反重复 ${score.proseRepetition} 低于硬线 ${NOVEL_RELEASE_PROSE_MIN}`)
  }
  return blockers
}

export function novelReleaseWindowSourceHash(chapters: NovelReleaseWindowChapter[]): string {
  return createHash('sha256').update(JSON.stringify(chapters.map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    status: chapter.status ?? null,
    content: chapter.content?.trim() ?? ''
  })))).digest('hex')
}

/** 只返回已经完整提交的连续八章窗口；尾部不足八章不能伪装成首发包。 */
export function planCompletedNovelReleaseWindows(
  chapters: NovelReleaseWindowChapter[],
  windowSize = NOVEL_RELEASE_WINDOW_SIZE
): NovelReleaseWindowRange[] {
  if (!Number.isInteger(windowSize) || windowSize <= 0) throw new Error('首发窗口大小必须是正整数')
  const committedPrefix: NovelReleaseWindowChapter[] = []
  for (const chapter of chapters) {
    if (chapter.status !== 'completed' || !chapter.content?.trim()) break
    committedPrefix.push(chapter)
  }
  const windows: NovelReleaseWindowRange[] = []
  for (let start = 0; start + windowSize <= committedPrefix.length; start += windowSize) {
    const rows = committedPrefix.slice(start, start + windowSize)
    windows.push({
      startIndex: start + 1,
      endIndex: start + windowSize,
      startChapterId: rows[0].id,
      endChapterId: rows.at(-1)!.id,
      chapters: rows,
      sourceHash: novelReleaseWindowSourceHash(rows)
    })
  }
  return windows
}
