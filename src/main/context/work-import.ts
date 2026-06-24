import { dialog } from 'electron'
import path from 'path'
import { readFileSync } from 'fs'
import { workDAO, volumeChapterDAO } from '../db'
import { initWritingPlanForWork } from './writing-plan'
import { extractTextFromDocx, isDocxFileName } from './assistant/docx-extract'

export interface ManuscriptImportResult {
  success: boolean
  workId?: number
  chapterCount?: number
  error?: string
  cancelled?: boolean
}

/**
 * 章节标题正则：匹配「第X章/节/回/卷/话」或「Chapter N」开头行
 */
const CHAPTER_HEADING_RE = /^[ \t]*第[一二三四五六七八九十百千零两0-9]+[章节回卷话篇]/m
const SPLIT_RE = /(?:\r\n|\n|\r)(?=[ \t]*第[一二三四五六七八九十百千零两0-9]+[章节回卷话篇])|(?:\r\n|\n|\r)(?=[ \t]*Chapter\s+\d+)/i

interface ParsedChapter {
  title: string
  content: string
}

/** 将纯文本切分为章节；无明确章节标题时整篇作为单章 */
function splitManuscript(text: string): ParsedChapter[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!CHAPTER_HEADING_RE.test(normalized) && !/^[ \t]*Chapter\s+\d+/im.test(normalized)) {
    return [{ title: '正文', content: normalized.trim() }]
  }
  const parts = normalized.split(SPLIT_RE).map(s => s.trim()).filter(Boolean)
  const chapters: ParsedChapter[] = []
  for (const part of parts) {
    const lineEnd = part.indexOf('\n')
    const title = lineEnd === -1 ? part.slice(0, 40) : part.slice(0, lineEnd).trim()
    const content = lineEnd === -1 ? '' : part.slice(lineEnd + 1).trim()
    chapters.push({ title: title || '未命名章节', content })
  }
  return chapters.length ? chapters : [{ title: '正文', content: normalized.trim() }]
}

function countWords(s: string): number {
  return s.replace(/\s/g, '').length
}

/**
 * 弹出文件选择对话框，导入 txt/docx 书稿并切分为章节，创建新作品。
 * 用于把已有书稿迁入系统继续创作。
 */
export async function pickAndImportManuscript(
  workType: 'novel' | 'story'
): Promise<ManuscriptImportResult> {
  const result = await dialog.showOpenDialog({
    title: workType === 'story' ? '导入短故事文稿' : '导入小说文稿',
    filters: [
      { name: '文稿', extensions: ['txt', 'docx', 'md'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }

  const filePath = result.filePaths[0]
  const fileName = path.basename(filePath)
  const baseTitle = fileName.replace(/\.(txt|docx|md)$/i, '')

  let text: string
  try {
    if (isDocxFileName(fileName)) {
      text = await extractTextFromDocx(readFileSync(filePath))
    } else {
      text = readFileSync(filePath, 'utf8')
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '读取文件失败' }
  }

  if (!text.trim()) return { success: false, error: '文件内容为空' }

  const chapters = splitManuscript(text)

  // 创建作品（不走 work:create 的 story 自动建卷逻辑，手动控制结构）
  const workId = workDAO.create({
    title: baseTitle,
    description: `从文稿「${fileName}」导入，共 ${chapters.length} ${workType === 'story' ? '拍' : '章'}`,
    workType,
    novelLength: 'medium'
  })
  initWritingPlanForWork(workId, 'medium')

  const volumeName = workType === 'story' ? '正文' : '导入正文'
  const volumeId = volumeChapterDAO.createVolume(workId, volumeName, '由文稿导入的正文内容')
  for (const ch of chapters) {
    volumeChapterDAO.createChapter(volumeId, ch.title, undefined)
    // createChapter 不接受 content，写入后单独更新正文与字数
  }

  // 回填正文与字数：取刚创建的章节列表按序对应
  const created = volumeChapterDAO.listChapters(volumeId)
  for (let i = 0; i < created.length && i < chapters.length; i++) {
    const ch = chapters[i]
    volumeChapterDAO.updateChapter(created[i].id, {
      content: ch.content,
      word_count: countWords(ch.content),
      status: ch.content ? 'completed' : 'draft'
    })
  }

  // 触发更新时间刷新
  workDAO.update(workId, { description: `从文稿「${fileName}」导入，共 ${chapters.length} ${workType === 'story' ? '拍' : '章'}` })

  return { success: true, workId, chapterCount: chapters.length }
}
