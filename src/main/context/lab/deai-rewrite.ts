import type { WebContents } from 'electron'
import { labTaskDAO, writingStyleDAO } from '../../db'
import { modelService } from '../../model'
import { extractTextFromDocx, isDocxFileName } from '../assistant/docx-extract'
import { BODY_PARAGRAPH_SPACING_RULE, normalizeModelBodyOutput } from '../../../shared/normalize-body-text'

const activeRuns = new Map<number, AbortController>()

function buildDeaiUserPrompt(originalText: string): string {
  return [
    '请参考目标范文对如下内容进行重新生成和改写，只输出改写后的正文，不要解释过程。',
    BODY_PARAGRAPH_SPACING_RULE,
    '',
    originalText
  ].join('\n')
}

export async function runDeaiRewrite(sender: WebContents, taskId: number): Promise<void> {
  const task = labTaskDAO.getById(taskId)
  if (!task) throw new Error('任务不存在')
  if (!task.original_text.trim()) throw new Error('原文不能为空')

  activeRuns.get(taskId)?.abort()
  const controller = new AbortController()
  activeRuns.set(taskId, controller)
  labTaskDAO.setRunning(taskId)

  if (!writingStyleDAO.getById(task.style_id)) throw new Error('所选文风不存在')

  const systemPrompt = task.system_prompt?.trim()
  if (!systemPrompt) throw new Error('System Prompt 不能为空')

  let fullContent = ''
  try {
    const response = await modelService.chat(
      {
        prompt: buildDeaiUserPrompt(task.original_text),
        systemPrompt,
        step: 'lab_deai',
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      },
      {
        signal: controller.signal,
        stream: true,
        suppressPhases: true,
        onDelta: (delta) => {
          fullContent += delta
          labTaskDAO.updateStreamingResult(taskId, fullContent)
          sender.send('lab:delta', { taskId, delta, content: fullContent })
        }
      }
    )

    if (response.cancelled) {
      labTaskDAO.setDone(taskId, fullContent)
      sender.send('lab:run-end', { taskId, success: false, error: '已取消' })
      return
    }

    if (!response.success) {
      throw new Error(response.error || '去AI味失败')
    }

    const rawFinal = response.content?.trim() || fullContent.trim()
    if (!rawFinal) throw new Error('模型未返回有效结果')
    const finalText = normalizeModelBodyOutput(rawFinal, 'lab_deai')

    labTaskDAO.setDone(taskId, finalText)
    sender.send('lab:delta', { taskId, delta: '', content: finalText })
    sender.send('lab:run-end', { taskId, success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '去AI味失败'
    labTaskDAO.setError(taskId, message)
    sender.send('lab:run-end', { taskId, success: false, error: message })
    throw error
  } finally {
    activeRuns.delete(taskId)
  }
}

export function cancelDeaiRewrite(taskId: number): boolean {
  const controller = activeRuns.get(taskId)
  if (!controller) return false
  controller.abort()
  activeRuns.delete(taskId)
  return true
}

export async function parseLabUploadFile(input: { fileName: string; base64: string }): Promise<string> {
  const fileName = input.fileName.trim()
  if (!fileName) throw new Error('文件名不能为空')
  if (!input.base64) throw new Error('文件内容为空')
  const buffer = Buffer.from(input.base64, 'base64')
  if (isDocxFileName(fileName)) {
    return extractTextFromDocx(buffer)
  }
  const text = buffer.toString('utf-8').trim()
  if (!text) throw new Error('文件内容为空')
  return normalizeModelBodyOutput(text, 'lab_deai')
}
