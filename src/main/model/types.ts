/**
 * 模型对接层类型定义
 */

import type { WebContents } from 'electron'
import type { AiSessionHandle } from '../ai/ai-session-manager'

import type { ProviderProtocol } from '../../shared/model-providers'

/** 内置模型类型标识（兼容旧代码） */
export type ModelType = 'deepseek' | 'kimi' | 'mimo' | 'bailian' | 'gemini' | 'openai' | 'anthropic' | (string & {})

export type ContextPressure = 'safe' | 'warning' | 'critical' | 'blocking'

export interface ContextBudgetSection {
  key: string
  label: string
  tokens: number
  included: boolean
  trimmed: boolean
  /** 固定规则 → system；作品/章节上下文 → user */
  target: 'system' | 'user'
  note?: string
}

export interface ContextBudgetReport {
  maxContextTokens: number
  reservedOutputTokens: number
  inputBudget: number
  usedTokens: number
  usageRatio: number
  pressure: ContextPressure
  warnings: string[]
  sections: ContextBudgetSection[]
  continuityMode: 'full' | 'tail' | 'none'
}

/** 模型调用请求 */
export interface ModelRequest {
  prompt: string
  systemPrompt?: string
  modelType?: ModelType           // 不指定则按优先级自动选择
  modelName?: string              // 指定具体模型 ID（覆盖提供商默认 model_name）
  maxTokens?: number
  temperature?: number
  thinkingEnabled?: boolean

  /** 频率惩罚：惩罚已出现 token 的重复使用，增加词汇多样性 (-2~2) */
  frequencyPenalty?: number
  /** 存在惩罚：惩罚任何已出现过的 token，鼓励引入新话题 (-2~2) */
  presencePenalty?: number
  /** 核采样参数：只从累积概率前 topP 的 token 中采样 (0~1) */
  topP?: number
  /** DeepSeek 思考模式（由 model-service 从提供商配置注入） */
  deepseekOptions?: import('../../shared/deepseek-api-params').DeepSeekProviderOptions
  workId?: number                 // 用于自动注入锚点和文风
  step?: string                   // 创作步骤标识
  styleId?: number                // 文风ID（未指定时从作品绑定文风自动取第一个）
  /** 是否自动注入作品上下文（idea/孵化器/核心设定），默认 true */
  enrichWorkContext?: boolean
  workContextOptions?: {
    includeIdea?: boolean
    includeIncubator?: boolean
    includeCoreSettings?: boolean
    includeVolumes?: boolean
    includeQualityIssues?: boolean
    /** 排除指定核心设定类型（如已由 narrative-memory 独立注入的 worldview） */
    excludeCoreTypes?: string[]
    volumeOutlineMode?: 'full' | 'compact' | 'names_only'
    currentVolumeId?: number
  }
  /** 是否注入叙事记忆体（伏笔/快照/时间线），正文生成默认 true */
  enrichNarrativeMemory?: boolean
  chapterId?: number
  volumeId?: number
}

/** 模型调用响应 */
export interface ModelResponse {
  success: boolean
  content: string
  modelType?: string
  error?: string
  usage?: {
    promptTokens: number
    completionTokens: number
  }
  durationMs?: number
  contextBudget?: ContextBudgetReport
  cancelled?: boolean
}

export interface AdapterChatOptions {
  onDelta?: (delta: string) => void
  onThinkingDelta?: (delta: string) => void
  signal?: AbortSignal
  stream?: boolean
  /** 内置提供商类型，用于 MiMo 等需特殊鉴权头的 OpenAI 兼容接口 */
  modelType?: string
}

/** 模型调用器接口 */
export interface ModelAdapter {
  readonly protocol: ProviderProtocol
  chat(
    request: ModelRequest,
    apiKey: string,
    apiBase: string,
    modelName?: string,
    options?: AdapterChatOptions
  ): Promise<ModelResponse>
}

/** modelService.chat 可选参数 */
export interface ChatOptions {
  webContents?: WebContents
  sessionTitle?: string
  sessionHandle?: AiSessionHandle
  /** 多步任务中由外层负责 complete */
  keepSession?: boolean
  signal?: AbortSignal
  /** 关闭流式输出（如并行辩论的前两步） */
  stream?: boolean
  /** 多步/并行任务中抑制「组装上下文」等通用阶段提示 */
  suppressPhases?: boolean
  /** 自定义流式 delta（如 AI 助手 IM），不创建 AiActivity 会话时可配合使用 */
  onDelta?: (delta: string) => void
  /** 自定义 thinking 流（如 AI 助手消息面板） */
  onThinkingDelta?: (delta: string) => void
}
