import path from 'path'

// ==================== 多模型注册表 ====================

export interface PerplexityModelDef {
  id: string
  name: string
  description: string
  filename: string
  url: string
  sizeBytes: number
  contextSize: number
}

export const PERPLEXITY_MODELS: PerplexityModelDef[] = [
  {
    id: 'qwen3.5-0.8b-q4',
    name: 'Qwen3.5 0.8B (推荐)',
    description: '2026最新，原生多模态架构，最轻量',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q4_K_M.gguf',
    sizeBytes: 532_517_120,
    contextSize: 4096,
  },
  {
    id: 'qwen3-0.6b-q4',
    name: 'Qwen3 0.6B',
    description: '参数最少，极速推理',
    filename: 'qwen3-0.6b-q4_k_m.gguf',
    url: 'https://modelscope.cn/models/Qwen/Qwen3-0.6B-GGUF/resolve/master/qwen3-0.6b-q4_k_m.gguf',
    sizeBytes: 530_000_000,
    contextSize: 4096,
  },
  {
    id: 'qwen3.5-2b-q4',
    name: 'Qwen3.5 2B',
    description: '2026最新，精度与体积平衡之选',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q4_K_M.gguf',
    sizeBytes: 1_280_000_000,
    contextSize: 4096,
  },
  {
    id: 'smollm3-3b-q4',
    name: 'SmolLM3 3B',
    description: 'HuggingFace 2026新模型，128K长上下文',
    filename: 'SmolLM3-3B-Q4_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/SmolLM3-3B-GGUF/resolve/master/SmolLM3-3B-Q4_K_M.gguf',
    sizeBytes: 1_920_000_000,
    contextSize: 4096,
  },
  {
    id: 'qwen3.5-4b-q4',
    name: 'Qwen3.5 4B',
    description: '2026最新，最佳性价比，推荐升级',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 2_740_937_888,
    contextSize: 4096,
  },
  {
    id: 'minicpm3-4b-q4',
    name: 'MiniCPM3 4B',
    description: '清华 OpenBMB，中文优化',
    filename: 'minicpm3-4b-q4_k_m.gguf',
    url: 'https://modelscope.cn/models/openbmb/MiniCPM3-4B-GGUF/resolve/master/minicpm3-4b-q4_k_m.gguf',
    sizeBytes: 2_500_000_000,
    contextSize: 2048,
  },
  {
    id: 'qwen3.5-9b-q4',
    name: 'Qwen3.5 9B',
    description: '最高精度，需要较多内存（约5.7GB）',
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/Qwen3.5-9B-GGUF/resolve/master/Qwen3.5-9B-Q4_K_M.gguf',
    sizeBytes: 5_680_000_000,
    contextSize: 4096,
  },
]

export const DEFAULT_MODEL_ID = 'qwen3.5-0.8b-q4'

// 兼容旧常量（供 calibrate 脚本使用）
export const PERPLEXITY_MODEL_ID = DEFAULT_MODEL_ID
const _defaultDef = PERPLEXITY_MODELS.find(m => m.id === DEFAULT_MODEL_ID)!
export const PERPLEXITY_MODEL_FILENAME = _defaultDef.filename
export const PERPLEXITY_MODEL_URL = _defaultDef.url
export const PERPLEXITY_MODEL_SIZE_BYTES = _defaultDef.sizeBytes

export function getModelDef(modelId: string): PerplexityModelDef {
  return PERPLEXITY_MODELS.find(m => m.id === modelId) || PERPLEXITY_MODELS[0]
}

export function getModelDir(userDataPath: string, modelId?: string): string {
  const id = modelId || DEFAULT_MODEL_ID
  return path.join(userDataPath, 'models', id)
}

export function getModelFilePath(userDataPath: string, modelId?: string): string {
  const def = getModelDef(modelId || DEFAULT_MODEL_ID)
  return path.join(getModelDir(userDataPath, def.id), def.filename)
}

/**
 * 检测参数 V5 — 默认阈值（基于 Qwen3.5-0.8B 校准，MAE=8.5%）
 * 
 * 核心思想：人类文本围绕基线波动，AI 文本偏离基线且三指标方向一致
 * - 模仿型AI → PPL低、Top5高、AvgProb高 (全部偏"可预测")
 * - 创意型AI → PPL高、Top5低、AvgProb低 (全部偏"不可预测")
 * - 人类文本 → 三指标方向不一致，散落在基线附近
 */
export const DETECT_THRESHOLDS = {
  baseline: {
    ppl: 83,
    top5: 0.505,
    avgProb: 0.183,
  },

  classify: {
    aiFloor: 58,
    humanCeiling: 22,
  },

  docBias: {
    boostThreshold: 35,
    boostFactor: 2.8,
    boostMax: 28,
    reduceThreshold: 25,
    reduceFactor: 1.2,
    reduceMax: 6,
  },

  weights: {
    ppl: 0.40,
    top5: 0.35,
    avgProb: 0.25
  },

  /** 启发式模式基线分（API logprobs 退化时使用） */
  heuristicBaseScore: 58,
}

/**
 * 每模型阈值覆盖 — 大参数模型对AI文本更敏感，需要更高的分类门槛
 * 4B 校准结果（mix-ai 朱雀样本，2026-06 重校，MAE≈21%）：
 *   baseline 从 A1-human 推导：PPL=22.52, Top5=0.600, AvgProb=0.320
 *   classify: aiFloor=68, humanCeiling=25
 *   科普体（A3）额外走 explainerMode：段落加分 + aiFloor 降至 54
 */
type ModelThresholdOverride = Partial<typeof DETECT_THRESHOLDS> & {
  /** 科普资讯体文档专用的更低 AI 门槛（仅 qwen3.5-4b-q4） */
  explainerAiFloor?: number
}

export const MODEL_THRESHOLD_OVERRIDES: Record<string, ModelThresholdOverride> = {
  /**
   * DeepSeek V4 Flash API 校准（朱雀 mix-ai 样本，MAE≈19.8%）
   * 云端 chat 复述 logprobs 全为 0，切换启发式检测
   */
  'deepseek-v4-flash': {
    heuristicBaseScore: 52,
    classify: { aiFloor: 72, humanCeiling: 50 },
    docBias: {
      boostThreshold: 68,
      boostFactor: 0.8,
      boostMax: 12,
      reduceThreshold: 48,
      reduceFactor: 1.0,
      reduceMax: 8,
    },
  },
  'qwen3.5-4b-q4': {
    baseline: { ppl: 22.52, top5: 0.600, avgProb: 0.320 },
    classify: { aiFloor: 68, humanCeiling: 25 },
    docBias: {
      boostThreshold: 42,
      boostFactor: 2,
      boostMax: 20,
      reduceThreshold: 22,
      reduceFactor: 1.0,
      reduceMax: 6,
    },
    /** 科普资讯体文档：4B 困惑度低估，需压低 AI 门槛 */
    explainerAiFloor: 54,
  },
  'qwen3.5-9b-q4': {
    baseline: { ppl: 18, top5: 0.68, avgProb: 0.35 },
    classify: { aiFloor: 72, humanCeiling: 26 },
    docBias: {
      boostThreshold: 45,
      boostFactor: 1.8,
      boostMax: 10,
      reduceThreshold: 30,
      reduceFactor: 2.0,
      reduceMax: 12,
    },
  },
}

/** 获取指定模型的合并后检测阈值 */
export function getDetectThresholds(modelId?: string) {
  const override = modelId ? MODEL_THRESHOLD_OVERRIDES[modelId] : undefined
  if (!override) return DETECT_THRESHOLDS

  return {
    baseline: { ...DETECT_THRESHOLDS.baseline, ...override.baseline },
    classify: { ...DETECT_THRESHOLDS.classify, ...override.classify },
    docBias: { ...DETECT_THRESHOLDS.docBias, ...override.docBias },
    weights: { ...DETECT_THRESHOLDS.weights, ...override.weights },
    heuristicBaseScore: override.heuristicBaseScore ?? DETECT_THRESHOLDS.heuristicBaseScore,
  }
}

/** API 模式优先用 modelName，本地模式用 GGUF modelId */
export function resolveDetectModelId(opts: {
  useApi: boolean
  apiModelName?: string
  localModelId?: string
}): string | undefined {
  if (opts.useApi && opts.apiModelName?.trim()) return opts.apiModelName.trim()
  return opts.localModelId
}

export const FUSION_WEIGHTS = {
  perplexity: 0.7,
  heuristic: 0.3
}
