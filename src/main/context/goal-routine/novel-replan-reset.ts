import { getDatabase } from '../../db/connection'
import { goalRoutineDAO, volumeChapterDAO, workDAO } from '../../db'
import {
  createConsistentAutoBackup,
  createWorkBundleBackup
} from '../../backup/work-backup'
import { isNovelGoalLoopRunning } from './novel-loop-lifecycle'
import { resetNovelGoalStateFromVolumePlan } from './novel-volume-planning'

export type NovelReplanSettingsMode = 'preserve' | 'regenerate'

export interface NovelReplanPreview {
  workId: number
  title: string
  volumeCount: number
  chapterCount: number
  bodyChapterCount: number
  totalWordCount: number
  authorityDecisionCount: number
  coreSettingCount: number
}

export interface NovelReplanResetResult extends NovelReplanPreview {
  settingsMode: NovelReplanSettingsMode
  databaseBackupPath: string
  workBackupPath: string
  nextPhase: 'materialize_settings'
}

function scalarCount(sql: string, workId: number): number {
  const row = getDatabase().prepare(sql).get(workId) as { count: number } | undefined
  return row?.count ?? 0
}

export function previewNovelReplanReset(workId: number): NovelReplanPreview {
  const work = workDAO.getById(workId)
  if (!work || work.work_type !== 'novel') throw new Error('只允许重新规划长篇小说')
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  return {
    workId,
    title: work.title,
    volumeCount: volumeChapterDAO.listVolumes(workId).length,
    chapterCount: chapters.length,
    bodyChapterCount: chapters.filter(chapter => Boolean(chapter.content?.trim())).length,
    totalWordCount: chapters.reduce((sum, chapter) => sum + Math.max(0, chapter.word_count || 0), 0),
    authorityDecisionCount: scalarCount(
      'SELECT COUNT(*) AS count FROM causal_chapter_decisions WHERE work_id = ?',
      workId
    ),
    coreSettingCount: scalarCount(
      'SELECT COUNT(*) AS count FROM core_settings WHERE work_id = ?',
      workId
    )
  }
}

/**
 * 仅执行已经完成备份和作者确认后的原子数据重置。
 * 对外入口必须调用 restartNovelPlanning，禁止绕过备份直接暴露给 IPC。
 */
export function performNovelReplanReset(
  workId: number,
  settingsMode: NovelReplanSettingsMode
): void {
  const db = getDatabase()
  db.transaction(() => {
    db.prepare('DELETE FROM story_release_snapshots WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM story_issue_ledger WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM story_lead_versions WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM story_generation_candidates WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM foreshadowing WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM story_timeline WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM emotional_state_ledger WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM resource_constraints WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM causal_plan_attempts WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM causal_state_revisions WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM causal_narrative_states WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM novel_authority_states WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM workflow_runs WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM goal_routine_turns WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM goal_routine_states WHERE work_id = ?').run(workId)
    db.prepare('DELETE FROM volumes WHERE work_id = ?').run(workId)

    if (settingsMode === 'regenerate') {
      db.prepare("DELETE FROM core_setting_versions WHERE work_id = ? AND type <> 'idea'").run(workId)
      db.prepare("DELETE FROM core_settings WHERE work_id = ? AND type <> 'idea'").run(workId)
      db.prepare('DELETE FROM anchors WHERE work_id = ?').run(workId)
      db.prepare('DELETE FROM name_entries WHERE work_id = ?').run(workId)
    }

    resetNovelGoalStateFromVolumePlan(workId)
    goalRoutineDAO.update(workId, {
      status: 'idle',
      desired_state: 'paused',
      turn_count: 0,
      current_phase: 'materialize_settings',
      goal_met: false
    })
  })()
}

export async function restartNovelPlanning(input: {
  workId: number
  confirmationTitle: string
  settingsMode: NovelReplanSettingsMode
}): Promise<NovelReplanResetResult> {
  const preview = previewNovelReplanReset(input.workId)
  if (!['preserve', 'regenerate'].includes(input.settingsMode)) {
    throw new Error('重新规划的设定范围无效')
  }
  if (input.confirmationTitle.trim().normalize('NFC') !== preview.title.trim().normalize('NFC')) {
    throw new Error('作品名确认不匹配，未执行重新规划')
  }
  const run = goalRoutineDAO.getByWork(input.workId)
  if (
    isNovelGoalLoopRunning(input.workId)
    || (run?.status === 'running' && run.desired_state === 'running')
  ) {
    throw new Error('小说目标循环仍在运行，请先暂停后再重新规划')
  }
  const integrity = getDatabase().pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new Error(`数据库完整性检查失败：${String(integrity)}`)

  const backupLabel = `work-${input.workId}-before-replan`
  const databaseBackupPath = await createConsistentAutoBackup(backupLabel)
  const workBackupPath = createWorkBundleBackup(input.workId, backupLabel)
  performNovelReplanReset(input.workId, input.settingsMode)
  return {
    ...preview,
    settingsMode: input.settingsMode,
    databaseBackupPath,
    workBackupPath,
    nextPhase: 'materialize_settings'
  }
}
