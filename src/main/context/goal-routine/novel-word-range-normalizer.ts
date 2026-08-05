import { modelService } from '../../model'
import { compileChapterExecutionContract } from '../chapter-execution-context'
import { formatChapterExecutionContract } from '../../../shared/chapter-execution-contract'
import { countWords } from '../../../shared/body-word-target'
import { withGoalLoopModelOptions } from './story-goal-model'
import { requestStructuredModelOutput } from './structured-model-output'
import type { ChapterWordRangeFailure } from './novel-chapter-acceptance'

export interface WordRangeCompressionDeletePatch {
  segmentId: string
  operation: 'delete'
  reason: string
}

export interface WordRangeCompressionReplacePatch {
  segmentId: string
  operation: 'replace'
  replace: string
  reason: string
}

export type WordRangeCompressionPatch =
  | WordRangeCompressionDeletePatch
  | WordRangeCompressionReplacePatch

export interface WordRangeExpansionPatch {
  segmentId: string
  insertAfter: string
  reason: string
}

export type WordRangePatch = WordRangeCompressionPatch | WordRangeExpansionPatch

export interface WordRangeSourceSegment {
  id: string
  text: string
  start: number
  end: number
}

export type AppliedWordRangePatch = WordRangePatch & { find: string }

export interface WordRangeSafeBand {
  min: number
  max: number
  preferred: number
}

export interface WordRangeExpansionPoolContract {
  patchCount: number
  minPatchWords: number
  maxPatchWords: number
}

export interface WordRangeNormalizationResult {
  content: string
  sourceWords: number
  finalWords: number
  safeBand: WordRangeSafeBand
  applied: AppliedWordRangePatch[]
}

function wordRangePatchSchema(
  direction: ChapterWordRangeFailure['direction'],
  allowedSegmentIds: string[],
  expansionContract?: WordRangeExpansionPoolContract
): Record<string, unknown> {
  if (allowedSegmentIds.length === 0) {
    throw new Error('字数补丁没有剩余可用正文片段')
  }
  const textField = direction === 'compress' ? 'replace' : 'insertAfter'
  const segmentIdSchema = {
    type: 'string',
    pattern: '^seg-[0-9]{4}$',
    enum: allowedSegmentIds
  }
  const reasonSchema = { type: 'string', minLength: 1, maxLength: 240 }
  const patchItems = direction === 'compress'
    ? {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['segmentId', 'operation', 'reason'],
            properties: {
              segmentId: segmentIdSchema,
              operation: { type: 'string', enum: ['delete'] },
              reason: reasonSchema
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['segmentId', 'operation', 'replace', 'reason'],
            properties: {
              segmentId: segmentIdSchema,
              operation: { type: 'string', enum: ['replace'] },
              replace: { type: 'string' },
              reason: reasonSchema
            }
          }
        ]
      }
    : {
        type: 'object',
        additionalProperties: false,
        required: ['segmentId', textField, 'reason'],
        properties: {
          segmentId: segmentIdSchema,
          [textField]: expansionContract
            ? {
                type: 'string',
                minLength: expansionContract.minPatchWords,
                maxLength: expansionContract.maxPatchWords
              }
            : { type: 'string', minLength: 1 },
          reason: reasonSchema
        }
      }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['patches'],
    properties: {
      patches: {
        type: 'array',
        minItems: expansionContract?.patchCount ?? 1,
        ...(expansionContract ? { maxItems: expansionContract.patchCount } : {}),
        items: patchItems
      }
    }
  }
}

export function wordRangeExpansionPoolContract(input: {
  requiredMinCapacity: number
  requiredMaxCapacity: number
  allowedSegmentCount: number
}): WordRangeExpansionPoolContract {
  if (
    input.requiredMinCapacity <= 0
    || input.requiredMaxCapacity < input.requiredMinCapacity
    || input.allowedSegmentCount <= 0
  ) {
    throw new Error('字数扩写池容量合同无效')
  }
  const patchCount = Math.min(
    8,
    input.allowedSegmentCount,
    input.requiredMaxCapacity,
    Math.max(1, Math.ceil(input.requiredMinCapacity / 90))
  )
  const minPatchWords = Math.ceil(input.requiredMinCapacity / patchCount)
  const maxPatchWords = Math.floor(input.requiredMaxCapacity / patchCount)
  if (maxPatchWords < minPatchWords) {
    throw new Error('字数扩写池无法分配满足安全区间的逐条容量')
  }
  return { patchCount, minPatchWords, maxPatchWords }
}

export function wordRangeSafeBand(range: ChapterWordRangeFailure): WordRangeSafeBand {
  const contractSpan = Math.max(1, range.max - range.min)
  const minimumMargin = Math.max(1, Math.min(12, Math.floor(contractSpan * 0.05)))
  const minimumWidth = Math.max(1, Math.min(64, Math.floor(contractSpan * 0.1)))
  if (range.direction === 'compress') {
    const overflow = Math.max(1, range.actual - range.max)
    const margin = Math.max(minimumMargin, Math.ceil(overflow / 3))
    const width = Math.max(minimumWidth, overflow)
    const max = Math.max(range.min, range.max - margin)
    const min = Math.max(range.min, max - width)
    return { min, max, preferred: Math.round((min + max) / 2) }
  }
  const shortfall = Math.max(1, range.min - range.actual)
  const margin = Math.max(minimumMargin, Math.ceil(shortfall / 3))
  const width = Math.max(minimumWidth, shortfall)
  const min = Math.min(range.max, range.min + margin)
  const max = Math.min(range.max, min + width)
  return { min, max, preferred: Math.round((min + max) / 2) }
}

export function buildWordRangeSourceSegments(source: string): WordRangeSourceSegment[] {
  const segments: WordRangeSourceSegment[] = []
  let start = 0
  let index = 0
  const push = (end: number) => {
    const text = source.slice(start, end)
    if (text.trim()) {
      index++
      segments.push({
        id: `seg-${String(index).padStart(4, '0')}`,
        text,
        start,
        end
      })
    }
    start = end
  }

  for (let cursor = 0; cursor < source.length; cursor++) {
    const char = source[cursor]
    if (char === '\n') {
      push(cursor + 1)
      continue
    }
    if (!/[。！？!?]/u.test(char)) continue
    let end = cursor + 1
    while (end < source.length && /[。！？!?…]/u.test(source[end])) end++
    while (end < source.length && /[”’"」』】）)]/u.test(source[end])) end++
    push(end)
    cursor = end - 1
  }
  if (start < source.length) push(source.length)
  return segments
}

interface LocatedPatch {
  patch: WordRangePatch
  segmentId: string
  reason: string
  find: string
  start: number
  end: number
  wordDelta: number
  replacement: string
}

function locatePatches(
  source: string,
  patches: WordRangePatch[],
  direction: ChapterWordRangeFailure['direction']
): LocatedPatch[] {
  const segments = buildWordRangeSourceSegments(source)
  if (patches.length === 0) throw new Error('字数归一化至少需要一条候选补丁')
  const segmentById = new Map(segments.map(segment => [segment.id, segment]))
  const usedSegmentIds = new Set<string>()
  const acceptedExpansionUnits: string[] = []
  const rejectedExpansionPatches: string[] = []
  const compactUnit = (value: string): string => value.replace(
    /[\s，。！？；：、“”‘’（）()《》—…,.!?;:'"-]/gu,
    ''
  )
  const expansionUnits = (value: string): string[] => value
    .split(/[\n。！？!?；;]/u)
    .map(compactUnit)
    .filter(unit => unit.length >= 12)
  const located = patches.flatMap(patch => {
    if (usedSegmentIds.has(patch.segmentId)) {
      throw new Error(`字数补丁重复引用片段：${patch.segmentId}`)
    }
    usedSegmentIds.add(patch.segmentId)
    const segment = segmentById.get(patch.segmentId)
    if (!segment) throw new Error(`字数补丁片段不存在：${patch.segmentId}`)
    const find = segment.text
    const reason = patch.reason.trim()
    if (!reason) throw new Error('字数补丁缺少删改理由')
    if (direction === 'compress' && !('operation' in patch)) {
      throw new Error(`字数${direction === 'compress' ? '压缩' : '扩写'}补丁字段与执行方向不一致`)
    }
    if (direction === 'expand' && !('insertAfter' in patch)) {
      throw new Error(`字数${direction === 'compress' ? '压缩' : '扩写'}补丁字段与执行方向不一致`)
    }
    if (direction === 'expand') {
      const insertion = (patch as WordRangeExpansionPatch).insertAfter
      const units = expansionUnits(insertion)
      const compactSource = compactUnit(source)
      if (units.some(unit => compactSource.includes(unit))) {
        rejectedExpansionPatches.push(
          `字数扩写补丁 ${patch.segmentId} 复制了已有正文句段，拒绝用复写制造字数`
        )
        return []
      }
      if (units.some(unit => acceptedExpansionUnits.includes(unit))) {
        rejectedExpansionPatches.push(`字数扩写补丁 ${patch.segmentId} 与同批新增句段重复`)
        return []
      }
      acceptedExpansionUnits.push(...units)
    }
    const replacement = direction === 'compress'
      ? (patch as WordRangeCompressionPatch).operation === 'delete'
        ? ''
        : (patch as WordRangeCompressionReplacePatch).replace
      : `${find}${(patch as WordRangeExpansionPatch).insertAfter}`
    const signedDelta = countWords(replacement) - countWords(find)
    const wordDelta = direction === 'compress' ? -signedDelta : signedDelta
    if (wordDelta <= 0) return []
    return [{
      patch,
      segmentId: patch.segmentId,
      find,
      reason,
      start: segment.start,
      end: segment.end,
      wordDelta,
      replacement
    }]
  }).sort((a, b) => a.start - b.start)
  if (located.length === 0) {
    const rejectionDetail = rejectedExpansionPatches.length > 0
      ? `：${rejectedExpansionPatches.join('；')}`
      : ''
    throw new Error(
      `字数候选池没有可执行的${direction === 'compress' ? '压缩' : '扩写'}补丁${rejectionDetail}`
    )
  }
  for (let index = 1; index < located.length; index++) {
    if (located[index].start < located[index - 1].end) {
      throw new Error('字数候选补丁存在重叠，拒绝以顺序覆盖制造隐式结果')
    }
  }
  return located
}

export function wordRangePatchPoolCapacity(input: {
  source: string
  direction: ChapterWordRangeFailure['direction']
  patches: WordRangePatch[]
}): number {
  return locatePatches(input.source, input.patches, input.direction)
    .reduce((sum, patch) => sum + patch.wordDelta, 0)
}

function choosePatchIndexes(
  patches: LocatedPatch[],
  requiredMinDelta: number,
  requiredMaxDelta: number,
  preferredDelta: number
): number[] {
  let choices = new Map<number, number[]>([[0, []]])
  patches.forEach((patch, index) => {
    const next = new Map(choices)
    for (const [delta, selected] of choices) {
      const combined = delta + patch.wordDelta
      if (combined <= requiredMaxDelta && !next.has(combined)) {
        next.set(combined, [...selected, index])
      }
    }
    choices = next
  })
  const feasible = [...choices.entries()]
    .filter(([delta]) => delta >= requiredMinDelta && delta <= requiredMaxDelta)
    .sort((a, b) => {
      const distance = Math.abs(a[0] - preferredDelta) - Math.abs(b[0] - preferredDelta)
      return distance || a[1].length - b[1].length
    })
  if (feasible.length === 0) {
    const capacity = patches.reduce((sum, patch) => sum + patch.wordDelta, 0)
    throw new Error(`字数候选补丁容量 ${capacity} 无法覆盖所需变化 ${requiredMinDelta}-${requiredMaxDelta}`)
  }
  return feasible[0][1]
}

export function applyWordRangePatchPool(input: {
  source: string
  range: ChapterWordRangeFailure
  patches: WordRangePatch[]
}): WordRangeNormalizationResult {
  const sourceWords = countWords(input.source)
  if (sourceWords !== input.range.actual) {
    throw new Error(`字数归一化输入已变化：计划 ${input.range.actual} 字，当前 ${sourceWords} 字`)
  }
  const safeBand = wordRangeSafeBand(input.range)
  const located = locatePatches(input.source, input.patches, input.range.direction)
  const requiredMinDelta = input.range.direction === 'compress'
    ? sourceWords - safeBand.max
    : safeBand.min - sourceWords
  const requiredMaxDelta = input.range.direction === 'compress'
    ? sourceWords - safeBand.min
    : safeBand.max - sourceWords
  const preferredDelta = input.range.direction === 'compress'
    ? sourceWords - safeBand.preferred
    : safeBand.preferred - sourceWords
  if (requiredMinDelta <= 0 || requiredMaxDelta < requiredMinDelta) {
    throw new Error('字数归一化计划与当前方向不一致')
  }
  const selectedIndexes = new Set(choosePatchIndexes(
    located,
    requiredMinDelta,
    requiredMaxDelta,
    preferredDelta
  ))
  const selected = located.filter((_, index) => selectedIndexes.has(index))
  let content = input.source
  for (const patch of [...selected].sort((a, b) => b.start - a.start)) {
    content = `${content.slice(0, patch.start)}${patch.replacement}${content.slice(patch.end)}`
  }
  const finalWords = countWords(content)
  if (finalWords < safeBand.min || finalWords > safeBand.max) {
    throw new Error(`字数补丁原子结果 ${finalWords} 未进入安全区间 ${safeBand.min}-${safeBand.max}`)
  }
  return {
    content,
    sourceWords,
    finalWords,
    safeBand,
    applied: selected.map(patch => ({ ...patch.patch, find: patch.find }))
  }
}

function validatePatchPool(
  value: Record<string, unknown>,
  direction: ChapterWordRangeFailure['direction'],
  forbiddenSegmentIds: string[] = []
): WordRangePatch[] {
  if (!Array.isArray(value.patches)) throw new Error('字数归一化缺少 patches')
  const forbidden = new Set(forbiddenSegmentIds)
  const seen = new Set<string>()
  return value.patches.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('字数补丁不是对象')
    }
    const row = item as Record<string, unknown>
    if (typeof row.segmentId !== 'string' || typeof row.reason !== 'string') {
      throw new Error('字数补丁字段类型错误')
    }
    if (forbidden.has(row.segmentId)) {
      throw new Error(`字数补充池重复引用已保留片段：${row.segmentId}`)
    }
    if (seen.has(row.segmentId)) {
      throw new Error(`字数补丁池内重复引用片段：${row.segmentId}`)
    }
    seen.add(row.segmentId)
    if (direction === 'compress') {
      if (row.operation === 'delete') {
        return { segmentId: row.segmentId, operation: 'delete', reason: row.reason }
      }
      if (row.operation !== 'replace' || typeof row.replace !== 'string') {
        throw new Error('字数压缩补丁必须是 delete 或带 replace 的 replace 操作')
      }
      return {
        segmentId: row.segmentId,
        operation: 'replace',
        replace: row.replace,
        reason: row.reason
      }
    }
    if (typeof row.insertAfter !== 'string') throw new Error('字数扩写补丁缺少 insertAfter')
    return { segmentId: row.segmentId, insertAfter: row.insertAfter, reason: row.reason }
  })
}

function formatWordRangeSourceSegments(source: string, allowedSegmentIds?: string[]): string {
  const allowed = allowedSegmentIds ? new Set(allowedSegmentIds) : null
  return buildWordRangeSourceSegments(source)
    .filter(segment => !allowed || allowed.has(segment.id))
    .map(segment => `[${segment.id}]${segment.text}`)
    .join('')
}

function canSupplementPatchPool(error: unknown): error is Error {
  return error instanceof Error && /字数候选补丁容量|没有可执行的(?:压缩|扩写)补丁/.test(error.message)
}

async function requestWordRangePatchPool(input: {
  workId: number
  chapterId: number
  direction: ChapterWordRangeFailure['direction']
  schema: Record<string, unknown>
  contractText: string
  source: string
  sourceText: string
  actualWords: number
  safeBand: WordRangeSafeBand
  requiredChange: string
  requiredMinCapacity: number
  requiredMaxCapacity: number
  expansionContract?: WordRangeExpansionPoolContract
  label: string
  forbiddenSegmentIds?: string[]
  businessError?: string
  signal?: AbortSignal
}): Promise<WordRangePatch[]> {
  return requestStructuredModelOutput<WordRangePatch[]>({
    workId: input.workId,
    label: input.label,
    attempts: 2,
    signal: input.signal,
    schema: input.schema,
    validate: value => {
      const patches = validatePatchPool(
        value,
        input.direction,
        input.forbiddenSegmentIds
      )
      if (input.expansionContract) {
        if (patches.length !== input.expansionContract.patchCount) {
          throw new Error(
            `字数扩写池必须返回 ${input.expansionContract.patchCount} 条独立补丁`
          )
        }
        for (const patch of patches) {
          const patchWords = countWords((patch as WordRangeExpansionPatch).insertAfter)
          if (
            patchWords < input.expansionContract.minPatchWords
            || patchWords > input.expansionContract.maxPatchWords
          ) {
            throw new Error(
              `字数扩写补丁 ${patch.segmentId} 净字数 ${patchWords} 未进入逐条区间 `
              + `${input.expansionContract.minPatchWords}-${input.expansionContract.maxPatchWords}`
            )
          }
        }
      }
      const capacity = wordRangePatchPoolCapacity({
        source: input.source,
        direction: input.direction,
        patches
      })
      if (capacity < input.requiredMinCapacity) {
        throw new Error(
          `字数补丁池可执行容量 ${capacity} 未覆盖最低所需变化 ${input.requiredMinCapacity}`
        )
      }
      return patches
    },
    request: async (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        chapterId: input.chapterId,
        step: 'body_length_normalization',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        forceThinkingDisabled: true,
        temperature: 0.1,
        maxTokens: attempt === 1 ? 6000 : 8000,
        responseSchema: {
          name: 'novel_word_range_patch_pool',
          schema: input.schema,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇小说字数归一化编辑，只针对程序提供的稳定片段 ID 提出补丁，不返回完整正文。',
          input.direction === 'compress'
            ? '只输出 JSON。整段冗余可用 {"segmentId":"seg-0001","operation":"delete","reason":"删除理由"}；承重段压缩可用 {"segmentId":"seg-0002","operation":"replace","replace":"更短文本","reason":"改写理由"}。'
            : '只输出 JSON：{"patches":[{"segmentId":"seg-0001","insertAfter":"仅新增的文本","reason":"为何不损伤合同"}]}。',
          `本次必须${input.direction === 'compress' ? '压缩' : '扩写'}，候选池需要覆盖所需变化 ${input.requiredChange}，最终由程序选择子集。`,
          input.expansionContract
            ? `扩写池必须恰好包含 ${input.expansionContract.patchCount} 条补丁；每条 insertAfter 的净字数必须在 ${input.expansionContract.minPatchWords}-${input.expansionContract.maxPatchWords} 字，程序将逐条复算。`
            : '',
          'segmentId 必须来自正文中的方括号标识；每个片段最多引用一次；禁止复制或改写 segmentId；候选总数不得超过正文片段数。',
          '保护人物行动、因果链、资源数值、伏笔兑现、转折、不可逆变化和章末钩子；不得新增事实或改变事件顺序。',
          input.direction === 'compress'
            ? '优先用 delete 删除重复解释、同义复述、冗余感官与不推进情节的整段；承载独有行动、因果、物证或数值的片段只能用 replace，且必须明显短于原片段。'
            : `只在现有事件内部补足动作反馈、因果过渡和具体感知；insertAfter 只能包含新增文本，严禁复制原片段或重写整章；每条新增文本不得超过本次所需变化上限 ${input.safeBand.max - input.actualWords} 字。`,
          input.businessError
            ? '这是补充池：此前有效候选会被程序保留；只提交覆盖剩余缺口的新候选，不得重做或复述已有候选。'
            : '',
          '禁止 Markdown、解释性前后缀和全文改写。'
        ].filter(Boolean).join('\n'),
        prompt: [
          input.contractText,
          `【当前字数】${input.actualWords}`,
          `【最终安全区间】${input.safeBand.min}-${input.safeBand.max}，优选 ${input.safeBand.preferred}`,
          input.businessError ? `【现有候选组合缺口】\n${input.businessError}` : '',
          attempt > 1
            ? `【上次候选池合同无效】\n${lastError}\n修正字段、引用或容量，并完整覆盖最低所需变化。`
            : '',
          `【带稳定片段 ID 的当前正文】\n${input.sourceText}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    )
  })
}

export async function normalizeNovelChapterWordRange(input: {
  workId: number
  chapterId: number
  content: string
  range: ChapterWordRangeFailure
  signal?: AbortSignal
}): Promise<WordRangeNormalizationResult> {
  const safeBand = wordRangeSafeBand(input.range)
  const requiredChange = input.range.direction === 'compress'
    ? `${input.range.actual - safeBand.max}-${input.range.actual - safeBand.min} 字`
    : `${safeBand.min - input.range.actual}-${safeBand.max - input.range.actual} 字`
  const contract = compileChapterExecutionContract(input.workId, input.chapterId)
  if (!contract) throw new Error(`章节 ${input.chapterId} 缺少可执行合同，禁止在无约束下归一化正文`)
  const sourceSegmentIds = buildWordRangeSourceSegments(input.content).map(segment => segment.id)
  const requiredMinCapacity = input.range.direction === 'compress'
    ? input.range.actual - safeBand.max
    : safeBand.min - input.range.actual
  const requiredMaxCapacity = input.range.direction === 'compress'
    ? input.range.actual - safeBand.min
    : safeBand.max - input.range.actual
  const primaryExpansionContract = input.range.direction === 'expand'
    ? wordRangeExpansionPoolContract({
        requiredMinCapacity,
        requiredMaxCapacity,
        allowedSegmentCount: sourceSegmentIds.length
      })
    : undefined
  const requestBase = {
    workId: input.workId,
    chapterId: input.chapterId,
    direction: input.range.direction,
    contractText: formatChapterExecutionContract(contract),
    source: input.content,
    sourceText: formatWordRangeSourceSegments(input.content),
    actualWords: input.range.actual,
    safeBand,
    requiredChange,
    requiredMinCapacity,
    requiredMaxCapacity,
    signal: input.signal
  }
  const primaryPatches = await requestWordRangePatchPool({
    ...requestBase,
    schema: wordRangePatchSchema(
      input.range.direction,
      sourceSegmentIds,
      primaryExpansionContract
    ),
    expansionContract: primaryExpansionContract,
    label: '章节字数补丁池'
  })
  try {
    return applyWordRangePatchPool({
      source: input.content,
      range: input.range,
      patches: primaryPatches
    })
  } catch (error) {
    if (!canSupplementPatchPool(error)) throw error
    const reservedSegmentIds = primaryPatches.map(patch => patch.segmentId)
    const reserved = new Set(reservedSegmentIds)
    const supplementalSegmentIds = sourceSegmentIds.filter(segmentId => !reserved.has(segmentId))
    const supplementalExpansionContract = input.range.direction === 'expand'
      ? wordRangeExpansionPoolContract({
          requiredMinCapacity: 1,
          requiredMaxCapacity,
          allowedSegmentCount: supplementalSegmentIds.length
        })
      : undefined
    const supplementalPatches = await requestWordRangePatchPool({
      ...requestBase,
      schema: wordRangePatchSchema(
        input.range.direction,
        supplementalSegmentIds,
        supplementalExpansionContract
      ),
      sourceText: formatWordRangeSourceSegments(input.content, supplementalSegmentIds),
      label: '章节字数补丁补充池',
      forbiddenSegmentIds: reservedSegmentIds,
      requiredMinCapacity: 1,
      expansionContract: supplementalExpansionContract,
      businessError: error.message
    })
    return applyWordRangePatchPool({
      source: input.content,
      range: input.range,
      patches: [...primaryPatches, ...supplementalPatches]
    })
  }
}
