/** 启发式：张力 / 反俗套 / 独特性（用于候选评分加成） */

const TENSION_TERMS = [
  '代价', '不可逆', '失去', '赌注', '对立', '抉择', '牺牲', '倒计时', '绝境',
  '追杀', '背叛', '决裂', '无法挽回', '两难', '撕裂', '崩', '赌', '命'
]

const CLICHE_TERMS = [
  '误会解除', '天降', '开挂', '巧合相遇', '英雄救美', '一眼万年', '霸道总裁',
  '重生逆袭', '系统奖励', '毫无代价', '轻松解决', '沟通就好', '真相大白后和好'
]

const UNIQUENESS_SIGNALS = [
  '反常识', '悖论', '不可能', '却', '偏偏', '只有', '除非', '代价是', '规则是'
]

export function scoreTextTension(text: string): number {
  const t = text.replace(/\s/g, '')
  let score = 48
  for (const term of TENSION_TERMS) {
    if (t.includes(term)) score += 4
  }
  return Math.min(100, score)
}

export function scoreTextAntiCliche(text: string): number {
  const t = text.replace(/\s/g, '')
  let penalty = 0
  for (const term of CLICHE_TERMS) {
    if (t.includes(term)) penalty += 12
  }
  return Math.max(0, 88 - penalty)
}

export function scoreTextUniqueness(text: string): number {
  const t = text.replace(/\s/g, '')
  let score = 50
  for (const term of UNIQUENESS_SIGNALS) {
    if (t.includes(term)) score += 6
  }
  // 跨域组合：中英文数字混排或少见标点结构略加分
  if (/[·「」【】]/.test(text)) score += 4
  return Math.min(100, score)
}
