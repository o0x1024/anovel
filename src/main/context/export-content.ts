import { coreSettingDAO, volumeChapterDAO, anchorDAO } from '../db'

export type ExportFormat = 'markdown' | 'txt' | 'html'

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
  const settings = coreSettingDAO.listByWork(workId)
  const volumes = volumeChapterDAO.listVolumes(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)

  let output = `# ${title}\n\n`

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

  output += `\n---\n导出工具：ANovel\n`
  return output
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
  scope?: { volumeId?: number; chapterId?: number }
): { content: string; filename: string; mime: string } {
  let md = buildMarkdown(workId, title)

  if (scope?.chapterId) {
    const ch = volumeChapterDAO.getChapter(scope.chapterId)
    if (ch) {
      md = `# ${ch.title}\n\n`
      if (ch.outline?.trim()) md += `${ch.outline}\n\n`
      if (ch.content?.trim()) md += `${ch.content}\n\n`
    }
  } else if (scope?.volumeId) {
    const vol = volumeChapterDAO.listVolumes(workId).find(v => v.id === scope.volumeId)
    const chapters = volumeChapterDAO.listChapters(scope.volumeId)
    if (vol) {
      md = `# ${vol.name}\n\n`
      if (vol.description) md += `${vol.description}\n\n`
      chapters.forEach((ch, idx) => {
        md += `## 第${idx + 1}章 ${ch.title}\n\n`
        if (ch.outline?.trim()) md += `${ch.outline}\n\n`
        if (ch.content?.trim()) md += `${ch.content}\n\n`
      })
    }
  }

  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_') || 'export'

  if (format === 'txt') {
    return { content: markdownToTxt(md), filename: `${safeTitle}.txt`, mime: 'text/plain;charset=utf-8' }
  }
  if (format === 'html') {
    return { content: markdownToHtml(md, title), filename: `${safeTitle}.html`, mime: 'text/html;charset=utf-8' }
  }
  return { content: md, filename: `${safeTitle}.md`, mime: 'text/markdown;charset=utf-8' }
}
