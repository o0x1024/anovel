import { DEFAULT_WORDS_PER_CHAPTER } from './writing-plan-presets'

export interface OutlineConstraints {
  pointsMin: number
  pointsMax: number
  charsMin: number
  charsMax: number
  charsWarn: number
}

/** 根据每章目标字数计算大纲约束（plot_points 数量 & 大纲字数） */
export function outlineConstraintsForWordTarget(wordsPerChapter = DEFAULT_WORDS_PER_CHAPTER): OutlineConstraints {
  if (wordsPerChapter <= 2500) {
    return { pointsMin: 3, pointsMax: 4, charsMin: 200, charsMax: 400, charsWarn: 600 }
  }
  if (wordsPerChapter <= 3500) {
    return { pointsMin: 3, pointsMax: 5, charsMin: 250, charsMax: 500, charsWarn: 700 }
  }
  if (wordsPerChapter <= 4500) {
    return { pointsMin: 4, pointsMax: 6, charsMin: 300, charsMax: 600, charsWarn: 800 }
  }
  return { pointsMin: 5, pointsMax: 8, charsMin: 400, charsMax: 800, charsWarn: 1000 }
}

export function formatOutlineConstraintLine(wordsPerChapter = DEFAULT_WORDS_PER_CHAPTER): string {
  const c = outlineConstraintsForWordTarget(wordsPerChapter)
  return `${c.pointsMin}-${c.pointsMax} 个情节节点，每节点 1-2 句；全文 ${c.charsMin}-${c.charsMax} 字`
}

export function formatOutlineCharRange(wordsPerChapter = DEFAULT_WORDS_PER_CHAPTER): string {
  const c = outlineConstraintsForWordTarget(wordsPerChapter)
  return `${c.charsMin}-${c.charsMax}`
}
