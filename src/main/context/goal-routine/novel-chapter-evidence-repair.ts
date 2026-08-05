import { modelService } from '../../model'
import type { ChapterExecutionContract } from '../../../shared/chapter-execution-contract'
import { formatChapterExecutionContract } from '../../../shared/chapter-execution-contract'
import { parseQualityAiPatchResponse } from '../../../shared/quality-ai-score'
import { withGoalLoopModelOptions } from './story-goal-model'
import { applyExactQualityPatches } from './novel-chapter-acceptance-policy'

export type NovelEvidenceRepairKind = 'emotion' | 'execution_contract' | 'causal_body_contract'

const EVIDENCE_PATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['patches'],
  properties: {
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['find', 'replace'],
        properties: {
          find: { type: 'string', minLength: 1 },
          replace: { type: 'string', minLength: 1 }
        }
      }
    }
  }
}

export async function repairNovelChapterByEvidencePatches(input: {
  workId: number
  chapterId: number
  content: string
  kind: NovelEvidenceRepairKind
  issues: string[]
  contract?: ChapterExecutionContract
  signal?: AbortSignal
}): Promise<{ success: boolean; content: string; appliedCount: number; error?: string }> {
  if (!input.content.trim()) {
    return { success: false, content: input.content, appliedCount: 0, error: '待修正文为空' }
  }
  if (input.issues.length === 0) {
    return { success: false, content: input.content, appliedCount: 0, error: '没有可定位的修订问题' }
  }
  const response = await modelService.chat(
    withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      chapterId: input.chapterId,
      step: input.kind === 'emotion'
        ? 'novel_emotion_patch_repair'
        : input.kind === 'causal_body_contract'
          ? 'novel_causal_body_contract_patch'
          : 'novel_execution_patch_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      forceThinkingDisabled: true,
      temperature: 0.15,
      maxTokens: 4000,
      responseSchema: {
        name: 'novel_evidence_repair_patches',
        schema: EVIDENCE_PATCH_SCHEMA,
        strict: true
      },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是长篇小说原文证据修订编辑。',
        '只输出 JSON：{"patches":[{"find":"原文中唯一且连续的精确片段","replace":"修改后的片段"}]}。',
        'find 必须逐字存在于当前正文且只能出现一次；每条尽量包含完整句段，禁止模糊引用。',
        '只修复列出的阻塞问题，未被证据覆盖的正文禁止改动。',
        '禁止返回完整正文，禁止 Markdown，最多 12 条补丁。'
      ].join('\n'),
      prompt: [
        input.contract ? formatChapterExecutionContract(input.contract) : '',
        `【阻塞问题】\n${input.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`,
        `【当前正文】\n${input.content}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    return {
      success: false,
      content: input.content,
      appliedCount: 0,
      error: response.error || '证据补丁修订失败'
    }
  }
  const patches = parseQualityAiPatchResponse(response.content)
  const applied = applyExactQualityPatches(input.content, patches)
  if (!applied.success) {
    return {
      success: false,
      content: input.content,
      appliedCount: 0,
      error: applied.error || '证据补丁无法原子应用'
    }
  }
  return {
    success: true,
    content: applied.content,
    appliedCount: applied.applied.length
  }
}
