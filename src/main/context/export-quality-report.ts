import { buildConsistencyReport } from './consistency-report'
import { volumeChapterDAO } from '../db'

export function buildExportQualityReport(workId: number, title: string): string {
  const report = buildConsistencyReport(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const withContent = chapters.filter(c => c.content?.trim())

  let md = `# ${title} · 整体质量报告\n\n`
  md += `> 由 ANovel 自动生成 · ${new Date().toLocaleString('zh-CN')}\n\n`

  md += `## 作品概览\n\n`
  md += `- 章节总数：${chapters.length}\n`
  md += `- 有正文章节：${withContent.length}\n`
  md += `- 有大纲章节：${report.chapters.withOutline}\n`
  md += `- 平均情绪强度：${report.chapters.avgEmotionIntensity}/10\n\n`

  md += `## 伏笔追踪\n\n`
  md += `- 伏笔总数：${report.foreshadowing.total}\n`
  md += `- 已回收：${report.foreshadowing.resolved}\n`
  md += `- 待回收：${report.foreshadowing.pending + report.foreshadowing.partial}\n`
  md += `- 回收率：**${report.foreshadowing.recoveryRate}%**\n`
  if (report.foreshadowing.deepPending > 0) {
    md += `- ⚠ 深伏笔待回收：${report.foreshadowing.deepPending}\n`
  }
  md += '\n'

  md += `## 叙事一致性\n\n`
  md += `- 追踪角色数：${report.characters.trackedCount}\n`
  md += `- 角色快照：${report.characters.snapshotCount} 条\n`
  md += `- 时间线事件：${report.timeline.eventCount}\n`
  md += `- 锚点对齐检测：${report.alignment.recentChecks} 次（未对齐 ${report.alignment.misalignedCount}）\n\n`

  if (report.warnings.length) {
    md += `## 警告\n\n`
    for (const w of report.warnings) md += `- ⚠ ${w}\n`
    md += '\n'
  }

  if (report.rhythmHints.length) {
    md += `## 节奏建议\n\n`
    for (const h of report.rhythmHints) md += `- ${h}\n`
    md += '\n'
  }

  if (report.warnings.length === 0 && report.rhythmHints.length === 0) {
    md += `## 总结\n\n整体一致性良好，可导出发布。\n`
  }

  return md
}
