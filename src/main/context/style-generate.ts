import type { WebContents } from 'electron'
import type { StyleAnalysisResult } from '../../shared/assistant-types'
import { modelService } from '../model'
import { resolvePrompt } from './prompt-registry'
import { extractStyleAnalysisFromReply, stripJsonBlockFromDisplay } from './assistant/style-analysis-parser'

export interface StyleGenerateResult {
  success: boolean
  analysis?: StyleAnalysisResult
  previewMarkdown?: string
  error?: string
}

/**
 * 根据用户文字描述，AI 生成完整文风配置（Prompt 模板、分步规则、样例段落等）。
 */
export async function generateStyleFromDescription(
  description: string,
  options?: { webContents?: WebContents }
): Promise<StyleGenerateResult> {
  const trimmed = description.trim()
  if (!trimmed) {
    return { success: false, error: '请先描述你想要的文风' }
  }

  const systemPrompt = resolvePrompt('style_generate.system')
  const userPrompt = [
    '【用户文风需求】',
    trimmed,
    '',
    '请根据以上描述，设计一套可直接用于 ANovel 正文生成的完整文风配置。',
    '样例段落须由你原创撰写（200-500字/段），体现所描述的风格，不要使用已有作品的内容。'
  ].join('\n')

  const res = await modelService.chat(
    {
      prompt: userPrompt,
      systemPrompt,
      step: 'style_generate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 8192
    },
    { webContents: options?.webContents }
  )

  if (!res.success) {
    return { success: false, error: res.error || '生成失败' }
  }

  const analysis = extractStyleAnalysisFromReply(res.content)
  if (!analysis) {
    return {
      success: false,
      error: 'AI 返回格式无效，未找到完整 JSON 配置块，请重试或调整描述'
    }
  }

  if (!analysis.sampleExcerpts?.length || !analysis.sampleExcerpts.some(s => s.trim())) {
    return {
      success: false,
      error: '生成结果缺少样例段落（sampleExcerpts），请重试'
    }
  }

  return {
    success: true,
    analysis,
    previewMarkdown: stripJsonBlockFromDisplay(res.content)
  }
}
