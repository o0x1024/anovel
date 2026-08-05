import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChapterIntentInput } from '../narrative-kernel/chapter-contracts'
import { NarrativeKernelError } from '../narrative-kernel/errors'
import {
  NarrativeApplication,
  renderPublicationMarkdown
} from './application'
import { loadNarrativeApplicationConfig } from './config'

type Command = 'init' | 'intent' | 'run' | 'resume' | 'cancel' | 'status' | 'export'

function usage(): never {
  throw new Error([
    '用法：npx jiti src/main/narrative-app/cli.ts <command> --config <path> [参数]',
    'init --novel-id <positive integer> --title <title>',
    'intent --file <chapter-intent.json>',
    'run --run-id <id> --novel-id <positive integer> --intent-id <id>',
    'resume --run-id <id>',
    'cancel --run-id <id>',
    'status --run-id <id>',
    'export --novel-id <positive integer> --output <publication.md>'
  ].join('\n'))
}

function parseArgs(argv: string[]): { command: Command; options: Map<string, string> } {
  const [command, ...rest] = argv
  if (!['init', 'intent', 'run', 'resume', 'cancel', 'status', 'export'].includes(command)) usage()
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value == null || options.has(key)) usage()
    options.set(key, value)
  }
  if (!options.has('--config')) usage()
  return { command: command as Command, options }
}

function option(options: Map<string, string>, name: string): string {
  const value = options.get(name)
  if (!value?.trim()) usage()
  return value
}

function exactOptions(options: Map<string, string>, allowed: readonly string[]): void {
  if (options.size !== allowed.length || [...options.keys()].some(key => !allowed.includes(key))) usage()
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', `${name} 必须是正整数`)
  }
  return number
}

function loadIntent(path: string): ChapterIntentInput {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ChapterIntentInput
  } catch (error) {
    throw new NarrativeKernelError(
      'CHAPTER_INTENT_INVALID',
      `无法读取章节契约 ${path}：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function runNarrativeCli(argv: string[]): Promise<void> {
  const { command, options } = parseArgs(argv)
  const configPath = resolve(option(options, '--config'))
  const app = NarrativeApplication.open(loadNarrativeApplicationConfig(configPath))
  try {
    switch (command) {
      case 'init':
        exactOptions(options, ['--config', '--novel-id', '--title'])
        app.createNovel({
          id: positiveInteger(option(options, '--novel-id'), '--novel-id'),
          title: option(options, '--title')
        })
        console.log(JSON.stringify({ status: 'created' }))
        return
      case 'intent':
        exactOptions(options, ['--config', '--file'])
        console.log(JSON.stringify(app.createIntent(loadIntent(resolve(option(options, '--file'))))))
        return
      case 'run': {
        exactOptions(options, ['--config', '--run-id', '--novel-id', '--intent-id'])
        const run = app.startChapter({
          runId: option(options, '--run-id'),
          novelId: positiveInteger(option(options, '--novel-id'), '--novel-id'),
          intentId: option(options, '--intent-id')
        })
        console.log(JSON.stringify(await app.runChapter(run.id)))
        return
      }
      case 'resume':
        exactOptions(options, ['--config', '--run-id'])
        console.log(JSON.stringify(await app.runChapter(option(options, '--run-id'))))
        return
      case 'cancel':
        exactOptions(options, ['--config', '--run-id'])
        console.log(JSON.stringify(app.cancelChapter(option(options, '--run-id'))))
        return
      case 'status':
        exactOptions(options, ['--config', '--run-id'])
        console.log(JSON.stringify(app.chapterStatus(option(options, '--run-id'))))
        return
      case 'export': {
        exactOptions(options, ['--config', '--novel-id', '--output'])
        const publication = app.publication(
          positiveInteger(option(options, '--novel-id'), '--novel-id')
        )
        const output = resolve(option(options, '--output'))
        writeFileSync(output, renderPublicationMarkdown(publication), { encoding: 'utf8', flag: 'wx' })
        console.log(JSON.stringify({ status: 'exported', output, stateHash: publication.stateHash }))
        return
      }
    }
  } finally {
    app.close()
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  runNarrativeCli(process.argv.slice(2)).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
