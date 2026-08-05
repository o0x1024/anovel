import { BaseDAO } from './base-dao'

export type ChapterEmotionCheckpointStage =
  | 'blind_read'
  | 'target_compare'
  | 'ledger_batch'

export interface ChapterEmotionCheckpointRow {
  id: number
  work_id: number
  chapter_id: number
  content_hash: string
  stage: ChapterEmotionCheckpointStage
  batch_key: string
  status: 'completed' | 'failed'
  payload_json: string | null
  attempt_count: number
  failure_code: string | null
  failure_message: string | null
  create_time: string
  update_time: string
}

class ChapterEmotionCheckpointDAO extends BaseDAO {
  find(
    chapterId: number,
    contentHash: string,
    stage: ChapterEmotionCheckpointStage,
    batchKey = ''
  ): ChapterEmotionCheckpointRow | undefined {
    return this.get<ChapterEmotionCheckpointRow>(
      `SELECT * FROM chapter_emotion_checkpoints
       WHERE chapter_id = ? AND content_hash = ? AND stage = ? AND batch_key = ?`,
      [chapterId, contentHash, stage, batchKey]
    )
  }

  listCompleted(
    chapterId: number,
    contentHash: string,
    stage: ChapterEmotionCheckpointStage
  ): ChapterEmotionCheckpointRow[] {
    return this.all<ChapterEmotionCheckpointRow>(
      `SELECT * FROM chapter_emotion_checkpoints
       WHERE chapter_id = ? AND content_hash = ? AND stage = ? AND status = 'completed'
       ORDER BY batch_key`,
      [chapterId, contentHash, stage]
    )
  }

  complete(input: {
    workId: number
    chapterId: number
    contentHash: string
    stage: ChapterEmotionCheckpointStage
    batchKey?: string
    payload: unknown
  }): void {
    this.run(
      `INSERT INTO chapter_emotion_checkpoints (
         work_id, chapter_id, content_hash, stage, batch_key, status,
         payload_json, attempt_count, failure_code, failure_message,
         create_time, update_time
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, NULL, NULL, datetime('now'), datetime('now'))
       ON CONFLICT(chapter_id, content_hash, stage, batch_key) DO UPDATE SET
         status = 'completed',
         payload_json = excluded.payload_json,
         failure_code = NULL,
         failure_message = NULL,
         update_time = datetime('now')`,
      [
        input.workId,
        input.chapterId,
        input.contentHash,
        input.stage,
        input.batchKey ?? '',
        JSON.stringify(input.payload)
      ]
    )
  }

  fail(input: {
    workId: number
    chapterId: number
    contentHash: string
    stage: ChapterEmotionCheckpointStage
    batchKey?: string
    failureCode: string
    failureMessage: string
  }): number {
    this.run(
      `INSERT INTO chapter_emotion_checkpoints (
         work_id, chapter_id, content_hash, stage, batch_key, status,
         payload_json, attempt_count, failure_code, failure_message,
         create_time, update_time
       ) VALUES (?, ?, ?, ?, ?, 'failed', NULL, 1, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(chapter_id, content_hash, stage, batch_key) DO UPDATE SET
         status = 'failed',
         payload_json = NULL,
         attempt_count = chapter_emotion_checkpoints.attempt_count + 1,
         failure_code = excluded.failure_code,
         failure_message = excluded.failure_message,
         update_time = datetime('now')`,
      [
        input.workId,
        input.chapterId,
        input.contentHash,
        input.stage,
        input.batchKey ?? '',
        input.failureCode,
        input.failureMessage
      ]
    )
    return this.find(
      input.chapterId,
      input.contentHash,
      input.stage,
      input.batchKey ?? ''
    )?.attempt_count ?? 1
  }

  deleteStale(chapterId: number, contentHash: string): number {
    return this.run(
      'DELETE FROM chapter_emotion_checkpoints WHERE chapter_id = ? AND content_hash <> ?',
      [chapterId, contentHash]
    ).changes
  }

  deleteByChapter(chapterId: number): number {
    return this.run(
      'DELETE FROM chapter_emotion_checkpoints WHERE chapter_id = ?',
      [chapterId]
    ).changes
  }
}

export const chapterEmotionCheckpointDAO = new ChapterEmotionCheckpointDAO()
