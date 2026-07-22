import { createHash } from 'crypto'
import { goalRoutineDAO, resourceLedgerDAO, volumeChapterDAO } from '../db'
import { compileChapterExecutionContract } from './chapter-execution-context'

type JsonRecord = Record<string, unknown>

export type ChapterOutlineGateStatus =
  | 'not_run'
  | 'queued'
  | 'running'
  | 'repairing'
  | 'passed'
  | 'deferred'
  | 'stalled'

export interface ChapterOutlineGateIssue {
  code: string
  problem: string
  requiredFix: string
  repairChapterNumbers: number[]
  appliesToChapter: boolean
}

export interface ChapterOutlineGateView {
  status: ChapterOutlineGateStatus
  volume: string
  score?: number
  rounds?: number
  reason?: string
  completedAt?: string
  summary?: string
  issues: ChapterOutlineGateIssue[]
  historicalScoreMissing?: boolean
}

function parseJsonRecord(raw: string | null | undefined, label: string, warnings: string[]): JsonRecord | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonRecord
    warnings.push(`${label}不是对象，暂时无法展示`)
  } catch {
    warnings.push(`${label}不是合法 JSON，暂时无法展示`)
  }
  return null
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter(item => Number.isInteger(item) && item > 0)
    : []
}

function gateIssues(value: unknown, chapterNumber: number): ChapterOutlineGateIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const issue = record(item)
    if (!issue) return []
    const repairChapterNumbers = numberList(issue.repairChapterNumbers)
    const evidenceChapterNumbers = Array.isArray(issue.evidence)
      ? issue.evidence.flatMap(row => {
          const evidence = record(row)
          const number = Number(evidence?.chapterNumber)
          return Number.isInteger(number) && number > 0 ? [number] : []
        })
      : []
    const appliesToChapter = repairChapterNumbers.length === 0
      || repairChapterNumbers.includes(chapterNumber)
      || evidenceChapterNumbers.includes(chapterNumber)
    return [{
      code: String(issue.code ?? 'VOLUME_GATE_ISSUE'),
      problem: String(issue.problem ?? '').trim(),
      requiredFix: String(issue.requiredFix ?? '').trim(),
      repairChapterNumbers,
      appliesToChapter
    }]
  })
}

function parseRuntimeState(workId: number): JsonRecord {
  const raw = goalRoutineDAO.getByWork(workId)?.state_json
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return record(parsed) ?? {}
  } catch {
    return {}
  }
}

function volumeGateSnapshotFingerprint(chapters: ReturnType<typeof volumeChapterDAO.listChapters>): string {
  const hash = createHash('sha256')
  for (const chapter of chapters) {
    hash.update(JSON.stringify({
      id: chapter.id,
      update_time: chapter.update_time,
      title: chapter.title,
      outline: chapter.outline,
      beat_role: chapter.beat_role,
      foreshadow_target: chapter.foreshadow_target,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      outline_diagnosis: chapter.outline_diagnosis,
      emotion_contract_json: chapter.emotion_contract_json
    }))
  }
  return hash.digest('hex')
}

function resolveGateView(
  runtime: JsonRecord,
  volumeName: string,
  chapterNumber: number,
  currentFingerprint: string
): ChapterOutlineGateView {
  const checkpoint = record(runtime.chapterVolumeGateCheckpoint)
  if (checkpoint?.volume === volumeName) {
    const assessments = Array.isArray(checkpoint.assessments) ? checkpoint.assessments : []
    const aggregate = record(checkpoint.aggregate)
    const assessmentRows = assessments.map(record).filter((item): item is JsonRecord => Boolean(item))
    const issues = [
      ...assessmentRows.flatMap(item => gateIssues(item.issues, chapterNumber)),
      ...gateIssues(aggregate?.issues, chapterNumber)
    ]
    const scores = [
      ...assessmentRows.map(item => Number(item.score)),
      Number(aggregate?.score)
    ].filter(Number.isFinite)
    const stalled = record(checkpoint.stalled)
    return {
      status: stalled ? 'stalled' : checkpoint.repair ? 'repairing' : 'running',
      volume: volumeName,
      score: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : undefined,
      rounds: Number.isFinite(Number(checkpoint.round)) ? Number(checkpoint.round) : undefined,
      reason: stalled ? String(stalled.reason ?? '').trim() : undefined,
      summary: aggregate ? String(aggregate.summary ?? '').trim() : undefined,
      issues
    }
  }

  const deferred = Array.isArray(runtime.volumeGateDeferredIssues)
    ? runtime.volumeGateDeferredIssues.map(record).find(item => item?.volume === volumeName)
    : undefined
  if (deferred) {
    return {
      status: 'deferred',
      volume: volumeName,
      score: Number.isFinite(Number(deferred.score)) ? Number(deferred.score) : undefined,
      rounds: Number.isFinite(Number(deferred.rounds)) ? Number(deferred.rounds) : undefined,
      reason: String(deferred.reason ?? '').trim(),
      completedAt: String(deferred.deferredAt ?? '').trim(),
      issues: gateIssues(deferred.issues, chapterNumber)
    }
  }

  const results = Array.isArray(runtime.chapterVolumeGateResults)
    ? runtime.chapterVolumeGateResults.map(record)
    : []
  const result = results.find(item => item?.volume === volumeName)
  if (result) {
    const savedFingerprint = String(result.snapshotFingerprint ?? '')
    if (savedFingerprint && savedFingerprint !== currentFingerprint) {
      return {
        status: 'not_run',
        volume: volumeName,
        reason: '章节大纲或结构合同在上次门禁后已变更，需要重新执行正式门禁',
        issues: []
      }
    }
    return {
      status: result.status === 'deferred' ? 'deferred' : 'passed',
      volume: volumeName,
      score: Number.isFinite(Number(result.score)) ? Number(result.score) : undefined,
      rounds: Number.isFinite(Number(result.rounds)) ? Number(result.rounds) : undefined,
      reason: String(result.reason ?? '').trim() || undefined,
      completedAt: String(result.completedAt ?? '').trim() || undefined,
      issues: gateIssues(result.issues, chapterNumber)
    }
  }

  const checked = Array.isArray(runtime.checkedChapterVolumes)
    && runtime.checkedChapterVolumes.includes(volumeName)
  if (checked) {
    return {
      status: 'passed',
      volume: volumeName,
      issues: [],
      historicalScoreMissing: true
    }
  }

  if (runtime.pendingChapterVolumeGate === volumeName) {
    return { status: 'queued', volume: volumeName, issues: [] }
  }
  return { status: 'not_run', volume: volumeName, issues: [] }
}

/** 汇总章节大纲页需要的只读合同和正式门禁状态，不改写任何作品数据。 */
export function getChapterPlanningDetails(workId: number, chapterId: number) {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter || volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) {
    throw new Error('章节不属于当前作品')
  }
  const volume = volumeChapterDAO.getVolume(chapter.volume_id)
  if (!volume) throw new Error('章节所属分卷不存在')

  const warnings: string[] = []
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const chapterNumber = chapters.findIndex(item => item.id === chapterId) + 1
  const runtime = parseRuntimeState(workId)
  const volumeFingerprint = volumeGateSnapshotFingerprint(volumeChapterDAO.listChapters(volume.id))

  return {
    chapterNumber,
    volumeName: volume.name,
    executionContract: compileChapterExecutionContract(workId, chapterId),
    structureContract: parseJsonRecord(chapter.outline_diagnosis, '章节结构合同', warnings),
    emotionContract: parseJsonRecord(chapter.emotion_contract_json, '情绪合同', warnings),
    emotionAssessment: parseJsonRecord(chapter.emotion_assessment_json, '情绪验收', warnings),
    qualityAssessment: parseJsonRecord(chapter.quality_assessment_json, '质量验收', warnings),
    resourceBudgets: resourceLedgerDAO.listBudgetsByChapter(workId, chapterId),
    gate: resolveGateView(runtime, volume.name, chapterNumber, volumeFingerprint),
    warnings
  }
}
