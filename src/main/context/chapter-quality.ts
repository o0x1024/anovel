import { volumeChapterDAO } from '../db'

export interface QualityCheckItem {
  key: string
  label: string
  severity: 'fatal' | 'warning' | 'info'
  passed: boolean
  detail: string
}

export interface QualityDiagnosisResult {
  items: QualityCheckItem[]
  fatalCount: number
  warningCount: number
  passed: boolean
  summary: string
  writerBlockHint?: string
}

/**
 * 规则驱动的章节质量诊断（开篇/密度/节奏/冲突/动态描写/视角）
 */
export function diagnoseChapterQuality(
  workId: number,
  chapterId: number,
  content: string,
  options?: { isFirstChapter?: boolean; povMode?: string | null }
): QualityDiagnosisResult {
  const items: QualityCheckItem[] = []
  const text = content.trim()
  const wordCount = text.replace(/\s/g, '').length
  const isFirst = options?.isFirstChapter ?? isFirstChapterOfWork(workId, chapterId)
  const ch = volumeChapterDAO.getChapter(chapterId)
  const povMode = options?.povMode ?? ch?.pov_mode ?? null

  if (isFirst) {
    const opening = text.slice(0, 300)
    const hasSettingDump = (opening.match(/设定|背景|世界观|体系/g) || []).length >= 2
    const hasScene = /说|道|看|走|站|坐|门|窗|雨|风|笑|喊|跑/.test(opening)
    items.push({
      key: 'opening_hook',
      label: '首页见山',
      severity: 'fatal',
      passed: hasScene && !hasSettingDump && opening.length >= 80,
      detail: hasSettingDump
        ? '开篇存在设定堆砌风险，建议先建立场景与期待'
        : hasScene
          ? '开篇较快进入场景'
          : '开篇缺少具体场景，建议加强画面感'
    })

    const dynamicSignals = countDynamicDescriptionSignals(opening)
    items.push({
      key: 'dynamic_opening',
      label: '动态描写',
      severity: 'warning',
      passed: dynamicSignals >= 2,
      detail: dynamicSignals >= 2
        ? '开篇含动作/声音/他人反应等动态元素'
        : '开篇偏静态陈述，建议用动作链或他人反应引入人物'
    })
  } else if (text.length >= 200) {
    const opening = text.slice(0, 200)
    const restartSignals = (opening.match(/话说|且说|与此同时|另一边|镜头转向|时间回到|让我们/g) || []).length
    items.push({
      key: 'continuity_restart',
      label: '衔接自然',
      severity: 'warning',
      passed: restartSignals === 0,
      detail: restartSignals > 0
        ? '开篇疑似重新开场，建议直接承接上一章结尾'
        : '未见明显重开场信号'
    })
  }

  const hookPatterns = [/然而|突然|没想到|究竟|到底|秘密|危险|明天|等待|消失|出现|发现/g]
  const lastPart = text.slice(-Math.min(500, text.length))
  const hookMatches = lastPart.match(hookPatterns) || []
  const nextHookTarget = ch?.next_hook?.trim()
  items.push({
    key: 'chapter_hook',
    label: '章末留钩',
    severity: 'fatal',
    passed: hookMatches.length >= 1 || /[？?…]$/.test(lastPart.trim()),
    detail: hookMatches.length >= 1
      ? nextHookTarget
        ? `章末有悬念信号；大纲钩子目标：${nextHookTarget}`
        : '章末存在悬念/转折信号'
      : nextHookTarget
        ? `章末钩子较弱，建议落实大纲目标：${nextHookTarget}`
        : '章末钩子较弱，建议增加悬念或冲突升级'
  })

  const tellCount = countTellNotShow(text)
  if (tellCount >= 5) {
    items.push({
      key: 'tell_not_show',
      label: '展示而非告知',
      severity: 'warning',
      passed: false,
      detail: `检测到约 ${tellCount} 处直述性格/外貌/情绪，建议改为事件与细节展示`
    })
  } else {
    items.push({
      key: 'tell_not_show',
      label: '展示而非告知',
      severity: 'info',
      passed: true,
      detail: tellCount > 0 ? `少量直述（${tellCount} 处），可接受` : '未发现明显直述堆砌'
    })
  }

  if (povMode === 'third_limited' || povMode === 'first') {
    const povIssues = detectPovShifts(text, povMode)
    items.push({
      key: 'pov_consistency',
      label: '视角一致',
      severity: povIssues > 2 ? 'warning' : 'info',
      passed: povIssues <= 2,
      detail: povIssues > 2
        ? `检测到约 ${povIssues} 处疑似视角切换/全知插入，建议统一叙事视角`
        : '视角基本稳定'
    })
  }

  const infoPoints = estimateInfoPoints(text)
  if (infoPoints > 8) {
    items.push({
      key: 'info_overload',
      label: '信息过载',
      severity: 'warning',
      passed: false,
      detail: `检测到约 ${infoPoints} 个信息点，建议拆分或删减`
    })
  } else if (infoPoints < 2 && wordCount > 2000) {
    items.push({
      key: 'info_sparse',
      label: '信息贫乏',
      severity: 'warning',
      passed: false,
      detail: '字数较多但信息点偏少，存在水文风险；可加快剧情或拉配角支线'
    })
  } else {
    items.push({
      key: 'info_density',
      label: '信息密度',
      severity: 'info',
      passed: true,
      detail: `约 ${infoPoints} 个核心信息点，密度适中`
    })
  }

  const conflictWords = text.match(/冲突|对抗| fight|打|杀|争|威胁|危机|敌人|对手/gi) || []
  items.push({
    key: 'conflict_strength',
    label: '冲突强度',
    severity: 'warning',
    passed: conflictWords.length >= 2,
    detail: conflictWords.length >= 2
      ? '章节存在明确冲突信号'
      : '冲突信号偏弱，建议强化对抗动机或代价'
  })

  const fatalCount = items.filter(i => !i.passed && i.severity === 'fatal').length
  const warningCount = items.filter(i => !i.passed && i.severity === 'warning').length

  let writerBlockHint: string | undefined
  if (items.some(i => i.key === 'info_sparse' && !i.passed)) {
    writerBlockHint = 'plot_stuck'
  } else if (items.some(i => i.key === 'continuity_restart' && !i.passed)) {
    writerBlockHint = 'flat_pacing'
  } else if (items.some(i => i.key === 'tell_not_show' && !i.passed)) {
    writerBlockHint = 'character_flat'
  }

  return {
    items,
    fatalCount,
    warningCount,
    passed: fatalCount === 0,
    summary: fatalCount > 0
      ? `发现 ${fatalCount} 项致命问题、${warningCount} 项警告`
      : warningCount > 0
        ? `无致命问题，${warningCount} 项需优化`
        : '基础质量检查通过',
    writerBlockHint
  }
}

function isFirstChapterOfWork(workId: number, chapterId: number): boolean {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  return chapters.length > 0 && chapters[0].id === chapterId
}

function estimateInfoPoints(text: string): number {
  const sentences = text.split(/[。！？\n]/).filter(s => s.trim().length > 8)
  let points = 0
  for (const s of sentences) {
    if (/发现|决定|出现|原来|得知|发生|变成|获得|失去|答应|拒绝/.test(s)) points++
  }
  return Math.min(points, 20)
}

function countDynamicDescriptionSignals(text: string): number {
  let score = 0
  if (/走|跑|站|坐|转|抬|低|握|推|拉|笑|哭|喊/.test(text)) score++
  if (/说|道|问|答|叫|骂/.test(text)) score++
  if (/听|看|望|瞥|盯/.test(text)) score++
  if (/风|雨|门|灯|脚步|笑声/.test(text)) score++
  return score
}

function countTellNotShow(text: string): number {
  const patterns = [
    /性格(?:很|十分|非常|极其|颇为)?/g,
    /为人(?:很|十分|非常)?/g,
    /(?:十分|非常|极其|特别)(?:美丽|漂亮|英俊|帅气|好看)/g,
    /(?:很|十分|非常)(?:善良|邪恶|冷酷|温柔|聪明|愚蠢|勇敢|胆小)/g,
    /给人一种.{0,6}的感觉/g
  ]
  let count = 0
  for (const p of patterns) {
    count += (text.match(p) || []).length
  }
  return count
}

function detectPovShifts(text: string, mode: string): number {
  const omniscientPatterns = [
    /他不知道的是/g,
    /与此同时，在.{2,20}(?:里|中|处)/g,
    /镜头(?:转向|切换到)/g,
    /(?:其实|实际上).{0,10}(?:心里|心中)/g
  ]
  if (mode === 'first') {
    omniscientPatterns.push(/他(?:想|觉得|感到)/g)
  }
  let count = 0
  for (const p of omniscientPatterns) {
    count += (text.match(p) || []).length
  }
  return count
}

export const QUALITY_AI_SYSTEM_PROMPT = [
  '你是番茄小说平台的资深编辑，对章节进行深度质量诊断。',
  '检查：开篇见山、章末留钩、信息密度、过渡章风险、冲突动机与代价、节奏情绪、',
  '动态描写（动作/声音/他人反应）、展示而非告知、视角一致性。',
  '输出 Markdown 报告，分 ## 致命问题 / ## 警告 / ## 优点 / ## 修改建议'
].join('\n')
