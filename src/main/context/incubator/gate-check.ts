import type { IncubatorGateReport } from '../../../shared/incubator-types'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import {
  INCUBATOR_FREEZE_MIN_FILLED_SLOTS,
  INCUBATOR_GATE_MIN_CONFLICT_CLOSURE,
  INCUBATOR_GATE_MIN_SERIALIZABILITY
} from '../../../shared/incubator-gate'
import { INCUBATOR_SLOT_KEYS } from '../../../shared/incubator-slots'
import { incubatorDraftSlotDAO, incubatorStateDAO } from '../../db/dao/incubator'

const STOPWORDS = new Set([
  '主角', '故事', '冲突', '核心', '推进', '世界', '规则', '角色', '情感', '结局', '终局',
  '以及', '然后', '但是', '如果', '为了', '需要', '通过', '这个', '那个', '他们', '我们',
  '并且', '因为', '所以', '就是', '一个', '一种', '进行', '出现', '相关', '设定', '展开',
  '开局', '中段', '高潮', '结尾', '读者', '方案', '版本', '变化', '阶段', '内容'
])

function tokenizeKeywords(text: string): Set<string> {
  const cleaned = text
    .replace(/[A-Za-z0-9_]+/g, ' ')
    .replace(/[\r\n\t，。！？；、：,.!?;:()[\]{}"'`~\-_/\\|<>@#$%^&*+=]+/g, ' ')
  const raw = cleaned
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 12)
    .filter(t => !STOPWORDS.has(t))
  return new Set(raw)
}

function keywordOverlapCount(a: string, b: string): number {
  const ka = tokenizeKeywords(a)
  const kb = tokenizeKeywords(b)
  let count = 0
  for (const t of ka) {
    if (kb.has(t)) count += 1
  }
  return count
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some(t => text.includes(t))
}

export function runIncubatorGate(workId: number): IncubatorGateReport {
  const slots = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Record<string, string> = {}
  for (const key of INCUBATOR_SLOT_KEYS) {
    slotMap[key] = slots.find(s => s.slot_key === key)?.content?.trim() ?? ''
  }

  const filledSlotCount = slots.filter(s => s.content.trim()).length

  const conflictText = slotMap.core_conflict
  const hookText = slotMap.hook
  const roleText = slotMap.role_engine
  const worldText = slotMap.world_rules
  const emotionText = slotMap.emotion_curve
  const endingText = slotMap.ending_image

  const serializabilityScore = filledSlotCount >= 4 ? 78 : filledSlotCount >= 2 ? 65 : 40
  const conflictClosureScore = conflictText
    ? Math.min(90, 60 + Math.floor(conflictText.replace(/\s/g, '').length / 30))
    : hookText
      ? 62
      : 35

  const issues: string[] = []
  const suggestions: string[] = []
  const coherence: IncubatorGateReport['coherence'] = []
  let blockingIssues = 0

  function addIssue(issue: string, suggestion: string, severity: 'blocking' | 'warning' = 'blocking'): void {
    issues.push(issue)
    suggestions.push(suggestion)
    if (severity === 'blocking') blockingIssues += 1
  }

  function addCoherence(
    slotKey: IncubatorSlotKey,
    issue: string,
    suggestion: string,
    severity: 'blocking' | 'warning' = 'blocking'
  ): void {
    addIssue(issue, suggestion, severity)
    coherence.push({ slotKey, severity, issue, suggestion })
  }

  if (filledSlotCount < INCUBATOR_FREEZE_MIN_FILLED_SLOTS) {
    addIssue(
      `主线槽位仅填满 ${filledSlotCount}/${INCUBATOR_FREEZE_MIN_FILLED_SLOTS}`,
      '继续从候选池采纳到「主冲突轴」「角色驱动轴」等槽位'
    )
  }
  if (serializabilityScore < INCUBATOR_GATE_MIN_SERIALIZABILITY) {
    addIssue('可连载性不足，缺少足够的情节延展线索', '在「世界规则轴」或「终局意象」补充长线伏笔')
  }
  if (conflictClosureScore < INCUBATOR_GATE_MIN_CONFLICT_CLOSURE) {
    addIssue('主冲突闭环不清晰', '在「主冲突轴」写清对立双方、赌注与终局结算方式')
  }

  // ------- 跨槽位一致性（P0 Gate v1）-------
  // 1) 主冲突 <-> 角色驱动：关键词至少有 2 个交集
  if (conflictText && roleText) {
    const overlap = keywordOverlapCount(conflictText, roleText)
    if (overlap < 2) {
      addCoherence(
        'role_engine',
        '主冲突轴与角色驱动轴疑似脱节：角色动机未有效支撑主冲突',
        '在角色驱动轴补充与主冲突一致的欲望/恐惧/选择代价，并复用同一组对立关键词'
      )
    }
  }

  // 2) 世界规则必须可施压：需要“代价/限制”语义，并能映射到冲突
  if (worldText) {
    const hasCost = hasAny(worldText, ['代价', '成本', '限制', '惩罚', '风险', '副作用', '寿命', '不可', '禁止', '失去'])
    if (!hasCost) {
      addCoherence(
        'world_rules',
        '世界规则轴缺少“规则代价”，难以形成持续压力',
        '在世界规则轴加入明确代价：触发条件 + 代价类型 + 失效后果'
      )
    }
    if (conflictText) {
      const overlap = keywordOverlapCount(worldText, conflictText)
      if (overlap < 1) {
        addCoherence(
          'world_rules',
          '世界规则轴与主冲突轴连接弱：规则未成为冲突推进器',
          '把主冲突中的关键对象或限制词嵌入世界规则轴，说明规则如何逼迫角色做选择'
        )
      }
    }
  }

  // 3) 情感曲线要有转折，不是平铺标签
  if (emotionText) {
    const hasTurns = hasAny(emotionText, ['转折', '反转', '低谷', '爆发', '高潮', '崩溃', '和解', '回升', '递进'])
    if (!hasTurns) {
      addCoherence(
        'emotion_curve',
        '情感曲线轴缺少关键转折点，曲线可能过平',
        '用“起点-转折-高潮-余韵”四段写法补齐，并绑定对应事件',
        'warning'
      )
    }
  }

  // 4) 终局意象应与开局钩子呼应
  if (hookText && endingText) {
    const overlap = keywordOverlapCount(hookText, endingText)
    const hasEchoWord = hasAny(endingText, ['呼应', '回扣', '镜像', '首尾', '开局', '开篇'])
    if (overlap < 1 && !hasEchoWord) {
      addCoherence(
        'ending_image',
        '终局意象与前台钩子缺少呼应，首尾闭环不足',
        '在终局意象加入对开局核心物件/动作/命题的回扣词，形成首尾镜像',
        'warning'
      )
    }
  }

  // 5) 角色弧线与终局收束应可达
  if (roleText && endingText) {
    const roleHasArc = hasAny(roleText, ['弧线', '起点', '终点', '成长', '变化', '转变'])
    const endingHasResolution = hasAny(endingText, ['结局', '终局', '最终', '选择', '代价', '收束', '落点'])
    if (!roleHasArc || !endingHasResolution) {
      addCoherence(
        'role_engine',
        '角色驱动轴与终局意象的收束关系不明确',
        '在角色驱动轴写“起点→终点”，在终局意象写“最后选择/代价”，保证角色弧线可闭合'
      )
    }
  }

  // 6) 明显互斥设定检测（轻量）
  if (worldText) {
    const worldSaysForbidden = hasAny(worldText, ['禁止', '不可', '不能', '无法'])
    const plotSaysBreak = hasAny(
      `${conflictText}\n${endingText}`,
      ['轻松解决', '毫无代价', '不受限制', '无视规则', '直接成功']
    )
    if (worldSaysForbidden && plotSaysBreak) {
      addCoherence(
        'world_rules',
        '世界规则轴与冲突/终局存在疑似互斥：规则约束被剧情直接绕过',
        '补充“破规则的代价与条件”，避免无代价破局导致可信度下降'
      )
    }
  }

  const passed =
    filledSlotCount >= INCUBATOR_FREEZE_MIN_FILLED_SLOTS &&
    serializabilityScore >= INCUBATOR_GATE_MIN_SERIALIZABILITY &&
    conflictClosureScore >= INCUBATOR_GATE_MIN_CONFLICT_CLOSURE &&
    blockingIssues === 0

  const report: IncubatorGateReport = {
    passed,
    filledSlotCount,
    serializabilityScore,
    conflictClosureScore,
    issues,
    suggestions,
    coherence
  }

  incubatorStateDAO.ensure(workId)
  incubatorStateDAO.setLastGateReport(workId, JSON.stringify(report))
  incubatorStateDAO.setState(workId, 'GateChecking')

  return report
}
