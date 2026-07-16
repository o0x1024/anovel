export type StoryContinuityEscalationMode = 'beat' | 'cluster' | 'contract' | 'engine' | 'storyline' | 'simplify'

export interface StoryContinuityEscalationState {
  fingerprint: string
  count: number
}

export interface StoryContinuityEscalationRoute extends StoryContinuityEscalationState {
  mode: StoryContinuityEscalationMode
  targetChapterIds: number[]
  hint: string
}

function blockerCodes(blockers: string[]): string[] {
  const text = blockers.join('\n')
  const codes: string[] = []
  if (/时间|日期|忌日|公示期|第[一二三四五六七八九十\d]+天|工作日/.test(text)) codes.push('TIMELINE')
  if (/地点|空间|座位|入场|离场/.test(text)) codes.push('SPACE')
  if (/阻碍|拉闸|断网|封杀|反制|降智/.test(text)) codes.push('OBSTACLE')
  if (/证据|道具|U盘|档案|流水|录音|知情/.test(text)) codes.push('EVIDENCE')
  if (/合同|核心问题|核心规则|履约|设定/.test(text)) codes.push('CONTRACT')
  if (/高潮|巧合|权威|官方|通报|立案|处置/.test(text)) codes.push('CLIMAX')
  if (/重复|复述/.test(text)) codes.push('REPETITION')
  if (codes.length === 0) codes.push('OTHER')
  return [...new Set(codes)].sort()
}

export function storyContinuityFingerprint(chapterId: number, blockers: string[]): string {
  return `${chapterId}:${blockerCodes(blockers).join(',')}`
}

export function routeStoryContinuityEscalation(
  chapterIds: number[],
  chapterId: number,
  blockers: string[],
  previous?: StoryContinuityEscalationState
): StoryContinuityEscalationRoute {
  const fingerprint = storyContinuityFingerprint(chapterId, blockers)
  const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1
  const index = chapterIds.indexOf(chapterId)
  const cluster = [...new Set([
    index > 0 ? chapterIds[index - 1] : undefined,
    chapterId
  ].filter((id): id is number => id != null))]
  const mode: StoryContinuityEscalationMode = count === 1
    ? 'beat'
    : count === 2
      ? 'cluster'
      : count === 3
        ? 'contract'
        : count === 4
          ? 'engine'
          : count === 5
            ? 'storyline'
            : 'simplify'
  const targetChapterIds = mode === 'beat'
    ? [chapterId]
    : mode === 'cluster' || mode === 'contract'
      ? cluster
      : chapterIds
  const actionText = mode === 'beat'
    ? '升级修订当前节拍蓝图'
    : mode === 'cluster'
      ? '升级联动修订上一拍与当前拍'
      : mode === 'contract'
        ? '升级重建故事合同后联动修订节拍簇'
        : mode === 'engine'
          ? '升级重建故事发动机与全篇合同，再修订全部节拍'
          : mode === 'storyline'
            ? '在新发动机约束下重写全篇节拍蓝图与正文'
            : '进入自动降复杂度：压缩为单一倒计时、单一证据载体、最少必要人物和四拍闭环，再重写全篇'
  return {
    mode,
    targetChapterIds,
    fingerprint,
    count,
    hint: [
      `同类连续性硬伤第 ${count} 次未在正文候选层收敛，${actionText}。`,
      ...blockers.map((blocker, i) => `${i + 1}. ${blocker}`),
      ...(mode === 'simplify'
        ? ['删除非必要身份反转和巧合式官方到场；每拍最多一次地点迁移和一次证据状态变化；结局只兑现核心冲突。']
        : []),
      '必须选择唯一权威时间线；阻碍必须有铺垫过的解法与代价；官方处置只能由既有证据和正常程序推动。'
    ].join('\n')
  }
}
