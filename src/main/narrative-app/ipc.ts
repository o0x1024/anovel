import { app, dialog } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelConfigDAO } from '../db/dao/model-config-dao'
import { appPreferenceDAO } from '../db/dao/app-preference-dao'
import {
  fixedProviderConfigFromModelRow,
  NarrativeKernelError
} from '../narrative-kernel'
import { safeIpcHandle } from '../ipc/ipc-safe'
import { NarrativeApplication, renderPublicationMarkdown } from './application'

interface StartAutoNovelInput {
  novelId: number
  premise: string
  targetChapters: number
  wordRange: { min: number; max: number }
}

const activeAutoNovelExecutions = new Map<string, NarrativeApplication>()

function launchAutoNovel(application: NarrativeApplication, runId: string): void {
  if (activeAutoNovelExecutions.has(runId)) return
  activeAutoNovelExecutions.set(runId, application)
  void application.runAutoNovel(runId).catch(() => undefined).finally(() => {
    activeAutoNovelExecutions.delete(runId)
    application.close()
  })
}

function resolveGlobalModel() {
  const selection = appPreferenceDAO.getGlobalLlmDefault()
  if (!selection.provider?.trim() || !selection.modelName?.trim()) {
    throw new NarrativeKernelError(
      'WORKFLOW_STATE_INVALID',
      '请先在系统设置中设置全局默认模型；V2 不提供单独模型选择'
    )
  }
  const row = modelConfigDAO.getByType(selection.provider)
  if (!row) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '全局默认模型的提供商配置不存在', selection)
  }
  return fixedProviderConfigFromModelRow({ ...row, model_name: selection.modelName.trim() })
}

function databasePath(): string {
  return join(app.getPath('userData'), 'narrative-v2.sqlite')
}

function openApplication(): NarrativeApplication {
  const model = resolveGlobalModel()
  return NarrativeApplication.open({
    databasePath: databasePath(),
    model,
    automation: {
      maxRepairs: 2,
      maxStepAttempts: 2,
      editorialPolicyVersion: 1
    }
  })
}

function assertAutoNovelInput(value: unknown): StartAutoNovelInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '自动全书启动参数必须是对象')
  }
  const input = value as StartAutoNovelInput
  if (!Number.isInteger(input.novelId) || input.novelId <= 0) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '小说 ID 必须是正整数')
  }
  if (typeof input.premise !== 'string' || input.premise.trim().length < 10) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '小说创意至少需要 10 个字符')
  }
  if (!Number.isInteger(input.targetChapters) || input.targetChapters <= 0 || input.targetChapters > 2000) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '目标章节数必须是 1 到 2000 的整数')
  }
  if (
    !input.wordRange || !Number.isInteger(input.wordRange.min) ||
    !Number.isInteger(input.wordRange.max) || input.wordRange.min <= 0 ||
    input.wordRange.max < input.wordRange.min
  ) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '单章字数范围无效')
  }
  return input
}

export function registerNarrativeV2IpcHandlers(): void {
  safeIpcHandle('narrativeV2:getGlobalModel', () => {
    const model = resolveGlobalModel()
    return { provider: model.provider, model: model.model }
  })

  safeIpcHandle('narrativeV2:listNovels', () => {
    const application = openApplication()
    try {
      return application.listNovels()
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:createNovel', (_event, title) => {
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '小说标题不能为空')
    }
    const application = openApplication()
    try {
      const id = application.createNovelWithGeneratedId(title)
      return application.listNovels().find(novel => novel.id === id)
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:getNovel', (_event, novelId) => {
    if (!Number.isInteger(novelId) || (novelId as number) <= 0) {
      throw new NarrativeKernelError('STREAM_NOT_FOUND', '小说 ID 必须是正整数')
    }
    const application = openApplication()
    try {
      const state = application.runner.pipeline.loadState(novelId as number)
      return {
        id: novelId,
        title: application.runner.pipeline.loadNovelTitle(novelId as number),
        state,
        chapters: application.runner.pipeline.listCommittedChapters(novelId as number)
      }
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:startAutoNovel', (_event, value) => {
    const input = assertAutoNovelInput(value)
    const application = openApplication()
    try {
      const run = application.startAutoNovel({
        runId: `v2:${input.novelId}:auto:${Date.now()}`,
        novelId: input.novelId,
        premise: input.premise.trim(),
        targetChapters: input.targetChapters,
        wordRange: input.wordRange
      })
      launchAutoNovel(application, run.id)
      return run
    } catch (error) {
      application.close()
      throw error
    }
  })

  safeIpcHandle('narrativeV2:listAutoNovelRuns', (_event, novelId) => {
    if (!Number.isInteger(novelId) || (novelId as number) <= 0) {
      throw new NarrativeKernelError('WORKFLOW_RUN_NOT_FOUND', '小说 ID 必须是正整数')
    }
    const application = openApplication()
    try {
      return application.listAutoNovelRuns(novelId as number)
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:getAutoNovelProgress', (_event, runId) => {
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new NarrativeKernelError('WORKFLOW_RUN_NOT_FOUND', '自动全书运行 ID 不能为空')
    }
    const application = openApplication()
    try {
      return application.autoNovelProgress(runId)
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:resumeAutoNovel', (_event, runId) => {
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new NarrativeKernelError('WORKFLOW_RUN_NOT_FOUND', '自动全书运行 ID 不能为空')
    }
    const application = openApplication()
    try {
      const run = application.autoNovelStatus(runId)
      if (run.status === 'running') launchAutoNovel(application, runId)
      else application.close()
      return run
    } catch (error) {
      application.close()
      throw error
    }
  })

  safeIpcHandle('narrativeV2:recoverAutoNovel', (_event, sourceRunId) => {
    if (typeof sourceRunId !== 'string' || sourceRunId.trim().length === 0) {
      throw new NarrativeKernelError('WORKFLOW_RUN_NOT_FOUND', '待恢复的自动全书运行 ID 不能为空')
    }
    const application = openApplication()
    try {
      const run = application.recoverAutoNovel(sourceRunId, `${sourceRunId}:recovery:${Date.now()}`)
      launchAutoNovel(application, run.id)
      return run
    } catch (error) {
      application.close()
      throw error
    }
  })

  safeIpcHandle('narrativeV2:cancelAutoNovel', (_event, runId) => {
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new NarrativeKernelError('WORKFLOW_RUN_NOT_FOUND', '自动全书运行 ID 不能为空')
    }
    const application = openApplication()
    try {
      return application.cancelAutoNovel(runId)
    } finally {
      application.close()
    }
  })

  safeIpcHandle('narrativeV2:export', async (_event, novelId) => {
    if (!Number.isInteger(novelId) || (novelId as number) <= 0) {
      throw new NarrativeKernelError('PUBLICATION_NOT_READY', '小说 ID 必须是正整数')
    }
    const application = openApplication()
    try {
      const publication = application.publication(novelId as number)
      const selected = await dialog.showSaveDialog({
        title: '导出 V2 发布稿',
        defaultPath: `${publication.title}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (selected.canceled || !selected.filePath) return { cancelled: true }
      if (existsSync(selected.filePath)) {
        throw new NarrativeKernelError(
          'PUBLICATION_NOT_READY',
          '导出文件已存在；请使用新的文件名，V2 不会覆盖现有发布稿',
          { filePath: selected.filePath }
        )
      }
      writeFileSync(selected.filePath, renderPublicationMarkdown(publication), 'utf8')
      return { cancelled: false, path: selected.filePath, stateHash: publication.stateHash }
    } finally {
      application.close()
    }
  })
}
