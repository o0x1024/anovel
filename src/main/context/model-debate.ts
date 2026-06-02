import type { WebContents } from 'electron'
import { modelService } from '../model'
import { modelConfigDAO } from '../db'
import type { ModelType } from '../model/types'
import { aiSessionManager } from '../ai/ai-session-manager'

export interface DebateVariant {
  modelType: string
  content: string
  success: boolean
  error?: string
  durationMs?: number
}

export interface DebateResult {
  variants: DebateVariant[]
  diffSummary: string
  fusionSuggestion: string
}

function simpleDiff(a: string, b: string): string {
  const aLines = a.split('\n').filter(l => l.trim())
  const bLines = b.split('\n').filter(l => l.trim())
  const onlyA = aLines.filter(l => !b.includes(l.slice(0, Math.min(20, l.length)))).slice(0, 3)
  const onlyB = bLines.filter(l => !a.includes(l.slice(0, Math.min(20, l.length)))).slice(0, 3)
  const parts: string[] = []
  if (onlyA.length) parts.push('版本A独有：\n' + onlyA.join('\n'))
  if (onlyB.length) parts.push('版本B独有：\n' + onlyB.join('\n'))
  return parts.join('\n\n') || '两版本整体结构相似，细节差异需人工比对'
}

export async function runModelDebate(
  workId: number,
  prompt: string,
  systemPrompt: string,
  modelTypes?: [ModelType, ModelType],
  webContents?: WebContents
): Promise<DebateResult> {
  const configs = modelConfigDAO.list().filter(c => c.is_enabled && c.api_key)
  const types: ModelType[] = modelTypes ?? [
    (configs[0]?.model_type as ModelType) || 'deepseek',
    (configs[1]?.model_type as ModelType) || (configs[0]?.model_type as ModelType) || 'openai'
  ]

  const uniqueTypes = [...new Set(types)].slice(0, 2) as ModelType[]
  const session = webContents
    ? aiSessionManager.create(webContents, '多模型辩论', ['生成版本 A', '生成版本 B', '融合分析'])
    : null
  const chatOpts = session
    ? { sessionHandle: session, keepSession: true as const, stream: false as const, suppressPhases: true as const }
    : undefined
  const fusionChatOpts = session
    ? { sessionHandle: session, keepSession: true as const }
    : undefined

  const results: DebateVariant[] = []

  try {
    const variantResults = await Promise.all(
      uniqueTypes.map(async (modelType, index) => {
        if (session) session.setStepRunning(index)
        const res = await modelService.chat({
          prompt,
          systemPrompt,
          workId,
          modelType,
          step: 'model_debate',
          enrichWorkContext: false,
          enrichNarrativeMemory: false
        }, chatOpts)
        if (session) {
          if (res.success) session.setStepDone(index)
          else session.setStepError(index, res.error)
        }
        return {
          modelType,
          content: res.content,
          success: res.success,
          error: res.error,
          durationMs: res.durationMs
        }
      })
    )
    results.push(...variantResults)

    const successVariants = results.filter(r => r.success && r.content.trim())
    let diffSummary = ''
    let fusionSuggestion = ''

    if (successVariants.length >= 2) {
      diffSummary = simpleDiff(successVariants[0].content, successVariants[1].content)
      if (session) {
        session.setStepRunning(2)
        session.clearStream()
      }
      const fusionRes = await modelService.chat({
        prompt: [
          '【版本A】\n' + successVariants[0].content.slice(0, 1500),
          '【版本B】\n' + successVariants[1].content.slice(0, 1500)
        ].join('\n\n'),
        systemPrompt: '对比两个版本，简述差异点，并给出融合建议（各取所长）。200字以内。',
        workId,
        step: 'model_debate_fusion',
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }, fusionChatOpts)
      fusionSuggestion = fusionRes.success ? fusionRes.content : ''
      if (session) {
        if (fusionRes.success) session.setStepDone(2)
        else session.setStepError(2, fusionRes.error)
      }
    } else if (session) {
      session.setStepDone(2)
    }

    if (session) {
      session.complete(true)
    }

    return { variants: results, diffSummary, fusionSuggestion }
  } catch (err) {
    if (session) {
      session.complete(false, String(err))
    }
    throw err
  }
}
