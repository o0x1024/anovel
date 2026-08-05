import Database from 'better-sqlite3'
import type { ChapterIntent, ChapterIntentInput } from '../narrative-kernel/chapter-contracts'
import {
  AutomatedChapterRunner,
  AutomatedNovelRunner,
  FixedOpenAICompatibleNarrativeModelGateway,
  NARRATIVE_PROMPT_PROTOCOL_VERSION,
  NarrativeKernelError,
  type NarrativeWorkflowRun
} from '../narrative-kernel'
import type { AutoNovelRun, StartAutoNovelInput } from '../narrative-kernel'
import type { NarrativeApplicationConfig } from './config'

export interface NarrativePublication {
  novelId: number
  title: string
  stateRevision: number
  stateHash: string
  chapters: Array<{
    ordinal: number
    content: string
    contentHash: string
    committedRevision: number
  }>
}

export class NarrativeApplication {
  readonly runner: AutomatedChapterRunner
  readonly autoNovels: AutomatedNovelRunner

  private constructor(
    private readonly db: Database.Database,
    private readonly config: NarrativeApplicationConfig
  ) {
    const gateway = new FixedOpenAICompatibleNarrativeModelGateway(config.model)
    this.runner = new AutomatedChapterRunner(db, gateway)
    this.autoNovels = new AutomatedNovelRunner(db, gateway)
  }

  static open(config: NarrativeApplicationConfig): NarrativeApplication {
    const db = new Database(config.databasePath)
    try {
      return new NarrativeApplication(db, config)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  createNovel(input: { id: number; title: string }): void {
    this.runner.pipeline.createNovel(input)
  }

  createNovelWithGeneratedId(title: string): number {
    return this.runner.pipeline.createNovelWithGeneratedId(title).workId
  }

  listNovels() {
    return this.runner.pipeline.listNovels()
  }

  createIntent(input: ChapterIntentInput): ChapterIntent {
    return this.runner.pipeline.registerIntent(input)
  }

  startChapter(input: { runId: string; novelId: number; intentId: string }): NarrativeWorkflowRun {
    return this.runner.start({
      runId: input.runId,
      novelId: input.novelId,
      intentId: input.intentId,
      maxRepairs: this.config.automation.maxRepairs,
      maxStepAttempts: this.config.automation.maxStepAttempts,
      editorialPolicyVersion: this.config.automation.editorialPolicyVersion,
      modelContract: {
        provider: this.config.model.provider,
        providerProtocol: this.config.model.providerProtocol,
        apiBase: this.config.model.apiBase,
        model: this.config.model.model,
        protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
      }
    })
  }

  async runChapter(runId: string): Promise<NarrativeWorkflowRun> {
    return this.runner.runToTerminal(runId)
  }

  cancelChapter(runId: string): NarrativeWorkflowRun {
    this.runner.workflows.requestCancellation(runId)
    return this.runner.workflows.loadRun(runId)
  }

  chapterStatus(runId: string): NarrativeWorkflowRun {
    return this.runner.workflows.loadRun(runId)
  }

  startAutoNovel(input: Omit<StartAutoNovelInput, 'modelContract'>): AutoNovelRun {
    return this.autoNovels.start({
      ...input,
      modelContract: {
        provider: this.config.model.provider,
        providerProtocol: this.config.model.providerProtocol,
        apiBase: this.config.model.apiBase,
        model: this.config.model.model,
        protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
      }
    })
  }

  async runAutoNovel(runId: string): Promise<AutoNovelRun> {
    return this.autoNovels.runToTerminal(runId)
  }

  autoNovelStatus(runId: string): AutoNovelRun {
    return this.autoNovels.loadRun(runId)
  }

  autoNovelProgress(runId: string) {
    return this.autoNovels.progress(runId)
  }

  recoverAutoNovel(sourceRunId: string, runId: string): AutoNovelRun {
    return this.autoNovels.recover({
      sourceRunId,
      runId,
      modelContract: {
        provider: this.config.model.provider,
        providerProtocol: this.config.model.providerProtocol,
        apiBase: this.config.model.apiBase,
        model: this.config.model.model,
        protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
      }
    })
  }

  listAutoNovelRuns(novelId: number): AutoNovelRun[] {
    return this.autoNovels.listRuns(novelId)
  }

  cancelAutoNovel(runId: string): AutoNovelRun {
    return this.autoNovels.requestCancellation(runId)
  }

  publication(novelId: number): NarrativePublication {
    const integrityErrors = this.runner.pipeline.integrityCheck()
    if (integrityErrors.length > 0) {
      throw new NarrativeKernelError(
        'PUBLICATION_NOT_READY',
        'SQLite 或外键完整性校验失败，不能导出发布稿',
        { integrityErrors }
      )
    }
    const state = this.runner.pipeline.loadState(novelId)
    const chapters = this.runner.pipeline.listCommittedChapters(novelId)
    if (chapters.length === 0) {
      throw new NarrativeKernelError('PUBLICATION_NOT_READY', '没有已提交章节，不能导出发布稿')
    }
    for (let index = 0; index < chapters.length; index += 1) {
      if (chapters[index].chapterOrdinal !== index + 1) {
        throw new NarrativeKernelError(
          'PUBLICATION_NOT_READY',
          '已提交章节序号必须从 1 连续递增，不能跳章发布',
          {
            expectedOrdinal: index + 1,
            actualOrdinal: chapters[index].chapterOrdinal
          }
        )
      }
    }
    return {
      novelId,
      title: this.runner.pipeline.loadNovelTitle(novelId),
      stateRevision: state.revision,
      stateHash: state.stateHash,
      chapters: chapters.map(chapter => ({
        ordinal: chapter.chapterOrdinal,
        content: chapter.content,
        contentHash: chapter.contentHash,
        committedRevision: chapter.committedRevision
      }))
    }
  }
}

export function renderPublicationMarkdown(publication: NarrativePublication): string {
  const frontmatter = [
    '---',
    `novelId: ${publication.novelId}`,
    `stateRevision: ${publication.stateRevision}`,
    `stateHash: ${publication.stateHash}`,
    '---'
  ].join('\n')
  const body = publication.chapters.map(chapter => [
    `# 第${chapter.ordinal}章`,
    '',
    chapter.content
  ].join('\n')).join('\n\n')
  return `${frontmatter}\n\n# ${publication.title}\n\n${body}\n`
}
