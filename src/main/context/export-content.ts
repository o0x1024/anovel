import { coreSettingDAO, volumeChapterDAO, anchorDAO, workDAO } from '../db'
import { isStoryWorkType, buildMergedStoryText } from '../../shared/work-terminology'

export type ExportFormat = 'markdown' | 'txt' | 'html'
export type ExportContentMode = 'full' | 'body'

const SETTING_LABELS: Record<string, string> = {
  idea: '故事方向',
  character: '人设',
  worldview: '世界观',
  conflict: '核心冲突',
  incubator_diagnose: '大岗诊断',
  incubator_variants: '变体探索',
  incubator_reverse: '倒推大纲',
  incubator_anchors: '提炼锚点',
  incubator_expand: '方向扩写',
  incubator_benchmark: '对标分析',
  incubator_tone: '情感基调'
}

function buildMarkdown(workId: number, title: string): string {
  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? null
  const settings = coreSettingDAO.listByWork(workId)
  const volumes = volumeChapterDAO.listVolumes(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)

  let output = `# ${title}\n\n`

  if (isStoryWorkType(workType)) {
    const hook = work?.description?.trim() ?? ''
    if (hook) output += `${hook}\n\n`
  }

  for (const s of settings) {
    if (s.content?.trim() && !s.type.startsWith('condition_')) {
      output += `## ${SETTING_LABELS[s.type] || s.type}\n\n${s.content}\n\n`
    }
  }

  const anchors = anchorDAO.listActiveByWork(workId)
  if (anchors.length) {
    output += `## 活跃锚点\n\n`
    for (const a of anchors) {
      output += `- **${a.title}**：${a.content}\n`
    }
    output += '\n'
  }

  if (isStoryWorkType(workType)) {
    const beatContents = chapters
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map(ch => ch.content?.trim() || '')
      .filter(Boolean)
    if (beatContents.length > 0) {
      output += buildMergedStoryText('', beatContents) + '\n\n'
    }
  } else {
    for (const vol of volumes) {
      const volChapters = chapters.filter(c => c.volume_id === vol.id).sort((a, b) => a.sort - b.sort)
      if (volChapters.length === 0 && !vol.description) continue
      output += `# ${vol.name}\n\n`
      if (vol.description) output += `${vol.description}\n\n`
      volChapters.forEach((ch, idx) => {
        output += `## 第${idx + 1}章 ${ch.title}\n\n`
        if (ch.outline?.trim()) output += `${ch.outline}\n\n`
        if (ch.content?.trim()) output += `${ch.content}\n\n`
      })
    }
  }

  output += `\n---\n导出工具：ANovel\n`
  return output
}

function buildBodyMarkdown(
  workId: number,
  title: string,
  scope?: { volumeId?: number; chapterId?: number }
): string {
  if (scope?.chapterId) {
    const ch = volumeChapterDAO.getChapter(scope.chapterId)
    return ch?.content?.trim() ? `${ch.content.trim()}\n` : ''
  }

  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? null
  const hook = work?.description?.trim() ?? ''

  if (scope?.volumeId) {
    const chapters = volumeChapterDAO.listChapters(scope.volumeId)
    const beatContents = chapters
      .sort((a, b) => a.sort - b.sort)
      .map(ch => ch.content?.trim() || '')
      .filter(Boolean)
    if (isStoryWorkType(workType)) {
      return beatContents.length > 0 ? buildMergedStoryText(hook, beatContents) + '\n' : ''
    }
    return beatContents.join('\n\n') + '\n'
  }

  const volumes = volumeChapterDAO.listVolumes(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const beatContents: string[] = []
  for (const vol of volumes) {
    const volChapters = chapters.filter(c => c.volume_id === vol.id).sort((a, b) => a.sort - b.sort)
    for (const ch of volChapters) {
      if (ch.content?.trim()) beatContents.push(ch.content.trim())
    }
  }
  if (beatContents.length === 0) return `# ${title}\n\n`

  if (isStoryWorkType(workType)) {
    return buildMergedStoryText(hook, beatContents) + '\n'
  }
  return beatContents.join('\n\n') + '\n'
}

function markdownToTxt(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
}

function markdownToHtml(md: string, title: string): string {
  const body = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:2rem auto;line-height:1.8;color:#222}
h1{border-bottom:2px solid #333}h2{color:#444;margin-top:2rem}li{margin:.3rem 0}</style></head>
<body><p>${body}</p></body></html>`
}

export function exportWorkContent(
  workId: number,
  title: string,
  format: ExportFormat,
  scope?: { volumeId?: number; chapterId?: number },
  mode: ExportContentMode = 'full'
): { content: string; filename: string; mime: string } {
  let md = mode === 'body'
    ? buildBodyMarkdown(workId, title, scope)
    : buildMarkdown(workId, title)

  if (mode !== 'body' && scope?.chapterId) {
    const ch = volumeChapterDAO.getChapter(scope.chapterId)
    if (ch) {
      md = `# ${ch.title}\n\n`
      if (ch.outline?.trim()) md += `${ch.outline}\n\n`
      if (ch.content?.trim()) md += `${ch.content}\n\n`
    }
  } else if (mode !== 'body' && scope?.volumeId) {
    const work = workDAO.getById(workId)
    const workType = work?.work_type ?? null
    const vol = volumeChapterDAO.listVolumes(workId).find(v => v.id === scope.volumeId)
    const chapters = volumeChapterDAO.listChapters(scope.volumeId)
    if (vol) {
      if (isStoryWorkType(workType)) {
        const hook = work?.description?.trim() ?? ''
        const beatContents = chapters
          .sort((a, b) => a.sort - b.sort)
          .map(ch => ch.content?.trim() || '')
          .filter(Boolean)
        md = buildMergedStoryText(hook, beatContents) + '\n'
      } else {
        md = `# ${vol.name}\n\n`
        if (vol.description) md += `${vol.description}\n\n`
        chapters.forEach((ch, idx) => {
          md += `## 第${idx + 1}章 ${ch.title}\n\n`
          if (ch.outline?.trim()) md += `${ch.outline}\n\n`
          if (ch.content?.trim()) md += `${ch.content}\n\n`
        })
      }
    }
  }

  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_') || 'export'
  const suffix = mode === 'body' ? '_纯正文' : ''

  if (format === 'txt') {
    return { content: markdownToTxt(md), filename: `${safeTitle}${suffix}.txt`, mime: 'text/plain;charset=utf-8' }
  }
  if (format === 'html') {
    return { content: markdownToHtml(md, title), filename: `${safeTitle}${suffix}.html`, mime: 'text/html;charset=utf-8' }
  }
  return { content: md, filename: `${safeTitle}${suffix}.md`, mime: 'text/markdown;charset=utf-8' }
}
