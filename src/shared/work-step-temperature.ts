/** 作品创作温度：8 组场景区间（min/max），作品内 LLM 在区间内随机采样 */
export type WorkTemperatureGroupKey =
  | 'outline'
  | 'worldview'
  | 'character'
  | 'body'
  | 'creative'
  | 'polish'
  | 'deai'
  | 'analysis'

export interface TemperatureRange {
  min: number
  max: number
}

export type WorkStepTemperatureConfig = Record<WorkTemperatureGroupKey, TemperatureRange>

export const TEMPERATURE_RANGE_BOUNDS = { min: 0, max: 2, step: 0.01 } as const

export const WORK_TEMPERATURE_GROUP_ORDER: WorkTemperatureGroupKey[] = [
  'outline',
  'worldview',
  'character',
  'body',
  'creative',
  'polish',
  'deai',
  'analysis'
]

export const WORK_TEMPERATURE_GROUP_LABELS: Record<WorkTemperatureGroupKey, string> = {
  outline: '大纲 / 情节规划',
  worldview: '世界观构建',
  character: '人设设计',
  body: '章节正文',
  creative: '创意 / 探索',
  polish: '润色 / 改稿',
  deai: '去 AI / 痕迹',
  analysis: '分析 / 自检'
}

export const WORK_TEMPERATURE_GROUP_HINTS: Record<WorkTemperatureGroupKey, string> = {
  outline: '分卷大纲、分章情节、单章大纲、倒推大纲等',
  worldview: '世界观生成与修订',
  character: '人设、人设卡片生成与修订',
  body: '章节正文生成',
  creative: '大岗探索、写作障碍、反均值化、多模型辩论等',
  polish: '文风重写、批判/质量修复、微指令改稿等',
  deai: 'AI 痕迹润色、叙事记忆提取等',
  analysis: '质量/设定自检、双通道批判、辩论融合等'
}

export const DEFAULT_WORK_STEP_TEMPERATURE: WorkStepTemperatureConfig = {
  outline: { min: 0.8, max: 1.0 },
  worldview: { min: 0.9, max: 1.2 },
  character: { min: 0.8, max: 1.0 },
  body: { min: 0.7, max: 0.9 },
  creative: { min: 0.9, max: 1.1 },
  polish: { min: 0.5, max: 0.7 },
  deai: { min: 0.4, max: 0.6 },
  analysis: { min: 0.5, max: 0.7 }
}

export function clampTemperatureValue(value: number): number {
  const { min, max, step } = TEMPERATURE_RANGE_BOUNDS
  if (!Number.isFinite(value)) return min
  const clamped = Math.min(max, Math.max(min, value))
  return Number((Math.round(clamped / step) * step).toFixed(2))
}

export function normalizeTemperatureRange(range: Partial<TemperatureRange> | undefined): TemperatureRange {
  let lo = clampTemperatureValue(range?.min ?? DEFAULT_WORK_STEP_TEMPERATURE.outline.min)
  let hi = clampTemperatureValue(range?.max ?? DEFAULT_WORK_STEP_TEMPERATURE.outline.max)
  if (lo > hi) [lo, hi] = [hi, lo]
  return { min: lo, max: hi }
}

export function mergeWorkStepTemperature(
  partial?: Partial<WorkStepTemperatureConfig> | null
): WorkStepTemperatureConfig {
  const merged = {} as WorkStepTemperatureConfig
  for (const key of WORK_TEMPERATURE_GROUP_ORDER) {
    merged[key] = normalizeTemperatureRange({
      min: partial?.[key]?.min ?? DEFAULT_WORK_STEP_TEMPERATURE[key].min,
      max: partial?.[key]?.max ?? DEFAULT_WORK_STEP_TEMPERATURE[key].max
    })
  }
  return merged
}

export function parseWorkStepTemperatureJson(json: string | null | undefined): WorkStepTemperatureConfig {
  if (!json?.trim()) return mergeWorkStepTemperature(null)
  try {
    const parsed = JSON.parse(json) as Partial<WorkStepTemperatureConfig>
    return mergeWorkStepTemperature(parsed)
  } catch {
    return mergeWorkStepTemperature(null)
  }
}

/** 在 [min, max] 内均匀随机，保留两位小数 */
export function sampleTemperatureInRange(min: number, max: number): number {
  const range = normalizeTemperatureRange({ min, max })
  if (range.max <= range.min) return range.min
  const value = range.min + Math.random() * (range.max - range.min)
  return Number(value.toFixed(2))
}
