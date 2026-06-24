import type { WebContents } from 'electron'
import type { StyleAnalysisResult } from '../../shared/assistant-types'
import { modelService } from '../model'
import { extractStyleAnalysisFromReply, stripJsonBlockFromDisplay } from './assistant/style-analysis-parser'

const STYLE_GENERATE_SYSTEM = [
  '你是 ANovel 的文风设计师。用户会用自然语言描述想要的写作风格，你的任务是根据描述生成一套可直接加载到写作系统的完整文风配置。',
  '',
  '输出分两部分：',
  '1. Markdown 摘要（400-600字）：风格身份、语言特征、情节引擎、决策规则摘要、检查清单摘要',
  '2. 紧跟其后的 ```json ... ``` 代码块，严格符合 StyleAnalysisResult 结构：',
  '',
  '{',
  '  "styleName": "简短文风名称",',
  '  "description": "一句话描述核心特征与读者体验",',
  '  "dimensions": {',
  '    "sentenceRhythm": "句段节奏（含量化数据）",',
  '    "dialogueStyle": "对话风格",',
  '    "narrativeDistance": "叙述距离",',
  '    "rhetoricPrefs": ["修辞偏好1", "修辞偏好2"],',
  '    "pacing": "节奏特征",',
  '    "vocabularyNotes": "词汇特征",',
  '    "taboos": ["禁止写法1", "禁止写法2"]',
  '  },',
  '  "promptTemplate": "以【文风要求】开头的6-12条编号创作规则（祈使句，可执行）",',
  '  "sampleExcerpts": ["原创样例段落1（200-500字）", "原创样例段落2（可选）"],',
  '  "confidence": "high|medium|low",',
  '  "warnings": [],',
  '  "stepRules": {',
  '    "identity": { "emotional_core": [], "target_reader": "", "style_keywords": [] },',
  '    "decision_rules": ["当 条件 → 动作（至少6条）"],',
  '    "pacing_rules": {',
  '      "conflict_interval": "XXX-XXX字",',
  '      "payoff_interval": "XXX-XXX字",',
  '      "chapter_end_must": [],',
  '      "emotion_loop": []',
  '    },',
  '    "quality_checklist": ["本章是否…？（至少6条）"]',
  '  }',
  '}',
  '',
  '规则：',
  '- promptTemplate 必须是可执行的创作指令，禁止文学赏析（如"文笔优美"）',
  '- sampleExcerpts 须原创撰写，体现所描述风格，用于文风指纹与 few-shot',
  '- stepRules 必须完整，含 decision_rules 与 quality_checklist',
  '- 配置中禁止出现具体作品角色名/地名，用「主角」「配角」等通用代称',
  '- 若用户描述模糊，基于网文常见类型合理推断并标注 warnings'
].join('\n')

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

  const systemPrompt = STYLE_GENERATE_SYSTEM
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
      enrichNarrativeMemory: false
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
