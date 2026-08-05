import { createHash } from 'node:crypto'
import {
  causalNovelDAO,
  coreSettingDAO,
  getDatabase,
  storyStateDAO,
  volumeChapterDAO
} from '../../db'
import {
  commitPreparedNarrativeMemory,
  prepareNarrativeMemoryAfterGeneration
} from './story-goal-doer'

const BASELINE_PROTOCOL = 'unified_novel_baseline_v1'
const BASELINE_SETTING_TYPE = 'causal_baseline_manifest'

interface BaselineChapterCoverage {
  chapterId: number
  title: string
  bodyHash: string
  factCount: number
  fingerprint: boolean
}

export interface CausalBaselineManifest {
  protocol: typeof BASELINE_PROTOCOL
  generatedAt: string
  chapters: BaselineChapterCoverage[]
}

function bodyHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readManifest(workId: number): CausalBaselineManifest | null {
  const content = coreSettingDAO.getByType(workId, BASELINE_SETTING_TYPE)?.content
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as CausalBaselineManifest
    return parsed.protocol === BASELINE_PROTOCOL && Array.isArray(parsed.chapters)
      ? parsed
      : null
  } catch {
    return null
  }
}

export function isCausalBaselineChapterCurrent(
  workId: number,
  chapterId: number,
  content?: string | null
): boolean {
  const manifest = readManifest(workId)
  const covered = manifest?.chapters.find(item => item.chapterId === chapterId)
  if (!covered) return false
  const current = content ?? volumeChapterDAO.getChapter(chapterId)?.content ?? ''
  return Boolean(current.trim()) && covered.bodyHash === bodyHash(current)
}

/**
 * 已有正文只允许作为因果状态的历史基线，不能再次成为 revision 0 之后的待提交章节。
 * 该事务不改写正文；它只撤销错误的未来决策，并把正文哈希绑定为基线事实。
 */
export function adoptCausalBaselineChapters(workId: number): number {
  const manifest = readManifest(workId)
  const state = causalNovelDAO.getState(workId)
  if (!manifest?.chapters.length || !state) return 0
  let adopted = 0
  getDatabase().transaction(() => {
    for (const item of manifest.chapters) {
      const chapter = volumeChapterDAO.getChapter(item.chapterId)
      if (!chapter?.content?.trim() || bodyHash(chapter.content) !== item.bodyHash) {
        throw new Error(`「${item.title}」正文已偏离因果基线，禁止把过期正文标记为历史章节`)
      }
      const decision = causalNovelDAO.getDecision(item.chapterId)
      if (decision?.status === 'committed') continue
      if (decision?.status === 'planned') causalNovelDAO.discardPlannedDecision(item.chapterId)
      const version = causalNovelDAO.ensureCurrentContentVersion(
        workId,
        item.chapterId,
        'causal_baseline',
        'generated'
      )
      causalNovelDAO.activateContentVersion({
        workId,
        chapterId: item.chapterId,
        contentVersionId: version.id,
        stateBeforeRevision: null,
        stateAfterRevision: state.revision,
        decisionStatus: 'baseline',
        bindingStatus: 'active'
      })
      volumeChapterDAO.updateChapter(item.chapterId, { status: 'completed' })
      adopted++
    }
  })()
  return adopted
}

/**
 * 旧长篇并入统一权威状态前，逐章建立可校验的事实与模式覆盖。
 * 任一章节抽取失败都会终止迁移，禁止用正文前缀或不完整摘要建立正式基线。
 */
export async function ensureCausalBaselineCoverage(
  workId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalBaselineManifest> {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
    .filter(chapter => Boolean(chapter.content?.trim()))
  const previous = readManifest(workId)
  const previousHashes = new Map(
    previous?.chapters.map(item => [item.chapterId, item.bodyHash]) ?? []
  )
  const fingerprints = new Set(
    storyStateDAO.listFingerprintsByWork(workId).map(item => item.chapter_id)
  )

  for (let index = 0; index < chapters.length; index++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const chapter = chapters[index]
    const hash = bodyHash(chapter.content!)
    const facts = storyStateDAO.listFactsByChapter(workId, chapter.id)
    const covered = previousHashes.get(chapter.id) === hash
      && facts.length > 0
      && fingerprints.has(chapter.id)
    if (covered) continue

    onProgress?.(
      `既有正文基线 ${index + 1}/${chapters.length}：正在提取「${chapter.title}」`
    )
    const prepared = await prepareNarrativeMemoryAfterGeneration(
      workId,
      chapter.id,
      chapter.content!,
      signal,
      { requirePatternFingerprint: true, dropInvalidStateFactsAfterRetries: true }
    )
    commitPreparedNarrativeMemory(workId, chapter.id, prepared, {
      markChapterCompleted: false
    })
    if (
      storyStateDAO.listFactsByChapter(workId, chapter.id).length === 0
      || !storyStateDAO.listFingerprintsByWork(workId)
        .some(item => item.chapter_id === chapter.id)
    ) {
      throw new Error(`「${chapter.title}」未形成完整事实与模式覆盖，拒绝建立迁移基线`)
    }
  }

  const latestFingerprints = new Set(
    storyStateDAO.listFingerprintsByWork(workId).map(item => item.chapter_id)
  )
  const manifest: CausalBaselineManifest = {
    protocol: BASELINE_PROTOCOL,
    generatedAt: new Date().toISOString(),
    chapters: chapters.map(chapter => ({
      chapterId: chapter.id,
      title: chapter.title,
      bodyHash: bodyHash(chapter.content!),
      factCount: storyStateDAO.listFactsByChapter(workId, chapter.id).length,
      fingerprint: latestFingerprints.has(chapter.id)
    }))
  }
  const incomplete = manifest.chapters.filter(item => item.factCount === 0 || !item.fingerprint)
  if (incomplete.length > 0) {
    throw new Error(`既有正文仍有 ${incomplete.length} 章缺少权威覆盖，拒绝继续生成`)
  }
  coreSettingDAO.upsert(workId, BASELINE_SETTING_TYPE, JSON.stringify(manifest))
  return manifest
}

export function buildCausalBaselineSeed(workId: number): string {
  const manifest = readManifest(workId)
  if (!manifest || manifest.chapters.length === 0) return ''
  const chapters = new Map(
    volumeChapterDAO.listChaptersByWork(workId).map(chapter => [chapter.id, chapter])
  )
  const chapterRows = manifest.chapters.map(item => {
    const chapter = chapters.get(item.chapterId)
    if (!chapter || bodyHash(chapter.content ?? '') !== item.bodyHash) {
      throw new Error(`「${item.title}」正文已在基线抽取后变化，必须重新执行基线迁移`)
    }
    return { item, chapter }
  })
  const latestFacts = new Map<string, ReturnType<typeof storyStateDAO.listFactsByWork>[number]>()
  for (const fact of storyStateDAO.listFactsByWork(workId)) {
    latestFacts.set(`${fact.entity}\u0000${fact.state_key}`, fact)
  }
  const recentChapterIds = new Set(
    chapterRows.slice(-8).map(row => row.item.chapterId)
  )
  return JSON.stringify({
    protocol: BASELINE_PROTOCOL,
    coverage: `${chapterRows.length}/${manifest.chapters.length}`,
    currentFacts: [...latestFacts.values()].map(fact => ({
      chapterId: fact.chapter_id,
      entity: fact.entity,
      key: fact.state_key,
      value: JSON.parse(fact.value_json) as unknown,
      transition: fact.transition,
      irreversible: fact.irreversible === 1,
      evidence: recentChapterIds.has(fact.chapter_id) ? fact.evidence : null
    })),
    recentChapters: chapterRows.slice(-8).map(({ item, chapter }) => ({
      chapterId: item.chapterId,
      title: item.title,
      volume: chapter.volume_name,
      bodyHash: item.bodyHash
    }))
  })
}
