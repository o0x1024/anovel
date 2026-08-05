<script setup lang="ts">
import { ref, computed, onActivated, watch, inject } from 'vue'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import AiSelfCheckPanel from './AiSelfCheckPanel.vue'
import StepNavFooter from './StepNavFooter.vue'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

interface ParsedVolume {
  name: string
  description: string
}

interface NovelReplanPreview {
  workId: number
  title: string
  volumeCount: number
  chapterCount: number
  bodyChapterCount: number
  totalWordCount: number
  authorityDecisionCount: number
  coreSettingCount: number
}

interface NovelReplanResult extends NovelReplanPreview {
  settingsMode: 'preserve' | 'regenerate'
  databaseBackupPath: string
  workBackupPath: string
  nextPhase: 'materialize_settings'
}

const volumes = ref<{ id: number; name: string; description: string | null; sort: number }[]>([])
const newVolumeName = ref('')
const addingVolume = ref(false)
const editingVolumeId = ref<number | null>(null)
const editVolumeName = ref('')
const editVolumeDesc = ref('')
const parsedVolumes = ref<ParsedVolume[]>([])
const applyingVolumes = ref(false)
const aiSuggestionExpanded = ref(true)
const expandedVolumeIds = ref<Set<number>>(new Set())
const { loading, result, error, chat, clearResult } = useModelChat(() => props.workId)
const lastContext = ref('')

const diagnosingVolumes = ref(false)
const volumeDiagnosisResult = ref('')
const volumeDiagnosisError = ref('')
const showDiagnosisResult = ref(false)

const fixingVolumes = ref(false)
const volumeFixError = ref('')
const volumeFixResult = ref('')

const batchSelectMode = ref(false)
const batchSelectedIds = ref<Set<number>>(new Set())
const currentWorkTitle = ref('')
const replanModalOpen = ref(false)
const replanPreview = ref<NovelReplanPreview | null>(null)
const replanSettingsMode = ref<'preserve' | 'regenerate'>('preserve')
const replanConfirmationTitle = ref('')
const replanLoading = ref(false)
const replanError = ref('')
const replanResult = ref<NovelReplanResult | null>(null)

const canConfirmReplan = computed(() =>
  !replanLoading.value
  && !!replanPreview.value
  && replanConfirmationTitle.value.trim().normalize('NFC')
    === currentWorkTitle.value.trim().normalize('NFC')
)

const diagnosisConclusion = computed(() => {
  if (!volumeDiagnosisResult.value) return ''
  const match = volumeDiagnosisResult.value.match(/【(PASS|REVISE|FAIL)】/)
  return match?.[1] ?? ''
})

const hasFixableIssues = computed(() => {
  return diagnosisConclusion.value === 'REVISE' || diagnosisConclusion.value === 'FAIL'
})

const volumeFixSystemPrompt = [
  '你是犀利、资深的网文总编辑，擅长根据诊断报告对分卷大纲进行精准修复。',
  '根据下方的诊断报告和当前分卷列表，对存在问题的分卷进行修复。',
  '',
  '修复要求：',
  '1. 修复每卷的 name 和 description 以解决诊断报告中指出的逻辑与质量问题',
  '2. 保持每卷 description 80-300 字（主题 + 主冲突 + 卷末钩子）',
  '3. name 须像真实分卷名（如「卷一：《标题》」）',
  '4. 只输出一个 JSON 对象，禁止 Markdown 正文、标题或额外文字',
  '5. patches 数组按需包含需修改的分卷，不修改的分卷不要输出',
  '',
  '输出格式示例：',
  '{"patches":[{"volumeId":1,"name":"卷一：《新标题》","description":"主题…；主冲突…；卷末钩子…"}]}'
].join('\n')

const volumeDiagnosisSystemPrompt = [
  '你是犀利、资深的网文总编辑，擅长从宏观角度诊断分卷大纲的逻辑结构与质量问题。',
  '请对提供的分卷大纲及作品设定进行全面诊断，重点关注以下方面：',
  '',
  '## 逻辑维度',
  '',
  '1. 【分卷递进逻辑】：各卷主题之间是否存在清晰的递进关系？冲突是否层层升级而非平行重复？',
  '2. 【因果链与收束设计】：跨卷的因果链条是否断裂？前期铺垫的悬念/伏笔是否在后续得到回应？',
  '3. 【冲突升级曲线】：从卷一至最后一卷，矛盾冲突是否持续升级？是否存在冲突强度停滞甚至回落的问题？',
  '4. 【故事弧完整性】：故事起承转合是否完整？高潮点分布是否合理？结局卷是否为积累的矛盾提供有力收束？',
  '5. 【角色动机跨卷一致性】：主要角色的行为逻辑和成长弧线是否跨卷一致？是否存在人设崩塌隐患？',
  '6. 【主线设定对齐】：各卷的发展是否与「主线设定」中的故事轨迹、关键转折点、阶段递进逻辑一致？是否存在偏离主线骨架的自由发挥？',
  '',
  '## 质量维度',
  '',
  '7. 【节奏与体量分布】：各卷说明的篇幅体量是否均匀？是否存在关键卷过于单薄或配比失衡？',
  '8. 【设定使用效率】：世界观规则和金手指设定是否被有效利用？是否存在设定了但后文未用的浪费？',
  '9. 【分卷说明质量】：每卷 description 是否清晰体现主题、主冲突和卷末钩子？是否存在描述空洞、模板化或信息不足的问题？',
  '10. 【分卷命名质量】：分卷名称是否有吸引力？是否为真实的分卷标题而非通用标签？是否存在命名重复或缺乏辨识度？',
  '11. 【钩子与悬念设计】：每卷末尾是否有足够的悬念或钩子推动读者进入下一卷？钩子是否与前文铺垫一致？',
  '',
  '## 诊断原则（极重要）',
  '',
  '- 只报告真正会影响读者体验的实质性问题，不要为了凑数而报告吹毛求疵的细节。',
  '- 如果某个维度没有实质性问题，直接写「✅ 无明显问题」，不要硬找毛病。',
  '- 区分问题严重程度：',
  '  🔴 阻断级：逻辑断裂、因果矛盾、人设崩塌——必须修复',
  '  🟡 改进级：可以更好但不影响理解——建议修复',
  '  ⚪ 微调级：锦上添花——可选修复',
  '- 只有存在 🔴 或 🟡 问题时才建议修复；如果全部为 ✅ 或 ⚪，应明确告知作者大纲已达标。',
  '',
  '【输出要求】',
  '报告第一行必须输出总体结论：【PASS】或【REVISE】或【FAIL】。',
  '- PASS = 无阻断级问题，最多 2 个改进级问题，可进入下一步',
  '- REVISE = 存在阻断级或 3 个以上改进级问题，建议修复后再继续',
  '- FAIL = 存在结构性缺陷，需重新设计分卷',
  '之后按维度输出诊断报告，每个问题标注严重程度（🔴/🟡/⚪），无问题的维度写「✅ 无明显问题」。',
  '报告应直接、犀利、实用，避免套话和泛泛之谈。不要输出 JSON。'
].join('\n')

const volumeSystemPrompt = [
  '根据作品创作上下文，生成 3-5 卷分卷大纲。',
  '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
  'volumes 数组每项为一卷；不要把「分卷大纲」「卷末钩子」「核心冲突」等标签当作 name。',
  '每卷 description 80-300 字（主题 + 主冲突 + 卷末钩子；如作品存在需连续追踪的能力/状态机制，也必须写清本卷状态约束与消耗/恢复/解锁节奏），禁止写具体章节情节或市场分析。',
  '可额外输出 state_constraints 字段承载能力/状态约束，解析时会并入 description。',
  '若核心设定明确要求无数值表达，state_constraints 禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数，只能用体感、场景边界和阶段性描述。',
  'name 须像真实分卷名（如「卷一：《标题》」），不要写作品名或文档标题。',
  '示例：{"volumes":[{"name":"卷一：《雨夜书店的猫》","description":"主题…；主冲突…；主角多次回收后逐渐乏力，污染刺痒感加重，卷末钩子…","state_constraints":"本卷主要体现回收带来的疲惫积累、污染不适加重与首次新品类解锁"}]}'
].join('\n')

const parseError = ref('')

onActivated(() => {
  void loadVolumes()
})

watch(() => props.workId, () => {
  void loadVolumes()
})

watch(result, async (content) => {
  if (!content) {
    parsedVolumes.value = []
    parseError.value = ''
    return
  }
  const list = await window.anovel.invoke('volume:parseSuggestions', content) as ParsedVolume[]
  parsedVolumes.value = list
  parseError.value = list.length === 0
    ? '未能从 AI 回复解析出分卷 JSON，请重新生成（需为 {"volumes":[...]} 格式）'
    : ''
})

function isInvalidVolumeName(name: string): boolean {
  const n = name.trim().replace(/^\*+|\*+$/g, '')
  return /^(?:卷末钩子|结尾钩子|核心冲突|核心主题|分卷大纲|分卷说明)/.test(n)
}

async function loadVolumes() {
  const [volumeRows, work] = await Promise.all([
    window.anovel.invoke('volume:list', props.workId),
    window.anovel.invoke('work:get', props.workId)
  ])
  volumes.value = volumeRows as never[]
  currentWorkTitle.value = String((work as { title?: string } | null)?.title ?? '')
}

async function addVolume() {
  if (!newVolumeName.value.trim()) return
  addingVolume.value = true
  await window.anovel.invoke('volume:create', props.workId, newVolumeName.value.trim())
  newVolumeName.value = ''
  await loadVolumes()
  addingVolume.value = false
}

async function deleteVolume(id: number, name: string) {
  if (!confirm(`删除分卷「${name}」会同时永久删除该卷全部章节正文和历史版本。确定继续？`)) return
  await window.anovel.invoke('volume:delete', id)
  await loadVolumes()
}

async function openReplanModal() {
  replanModalOpen.value = true
  replanLoading.value = true
  replanError.value = ''
  replanResult.value = null
  replanConfirmationTitle.value = ''
  replanSettingsMode.value = 'preserve'
  try {
    replanPreview.value = await window.anovel.invoke(
      'novel:previewReplanReset',
      props.workId
    ) as NovelReplanPreview
  } catch (cause) {
    replanError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    replanLoading.value = false
  }
}

function closeReplanModal() {
  if (replanLoading.value) return
  replanModalOpen.value = false
}

async function confirmReplanReset() {
  if (!canConfirmReplan.value) return
  replanLoading.value = true
  replanError.value = ''
  try {
    replanResult.value = await window.anovel.invoke('novel:restartPlanning', {
      workId: props.workId,
      confirmationTitle: replanConfirmationTitle.value,
      settingsMode: replanSettingsMode.value
    }) as NovelReplanResult
    await loadVolumes()
    await nav?.refreshProgress()
  } catch (cause) {
    replanError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    replanLoading.value = false
  }
}

function toggleBatchSelect() {
  batchSelectMode.value = !batchSelectMode.value
  if (!batchSelectMode.value) batchSelectedIds.value = new Set()
}

function toggleBatchItem(id: number) {
  const next = new Set(batchSelectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  batchSelectedIds.value = next
}

function selectAllVolumes() {
  if (batchSelectedIds.value.size === volumes.value.length) {
    batchSelectedIds.value = new Set()
  } else {
    batchSelectedIds.value = new Set(volumes.value.map(v => v.id))
  }
}

async function batchDeleteVolumes() {
  const count = batchSelectedIds.value.size
  if (count === 0) return
  if (!confirm(`确定删除选中的 ${count} 个分卷？这些分卷下的章节正文和历史版本会一起永久删除。`)) return
  await window.anovel.invoke('volume:batchDelete', [...batchSelectedIds.value])
  batchSelectedIds.value = new Set()
  batchSelectMode.value = false
  await loadVolumes()
  await nav?.refreshProgress()
}

function startEditVolume(vol: { id: number; name: string; description: string | null }) {
  editingVolumeId.value = vol.id
  editVolumeName.value = vol.name
  editVolumeDesc.value = vol.description || ''
  expandedVolumeIds.value = new Set([...expandedVolumeIds.value, vol.id])
}

function isVolumeExpanded(id: number): boolean {
  return expandedVolumeIds.value.has(id)
}

function toggleVolumeExpanded(id: number) {
  const next = new Set(expandedVolumeIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedVolumeIds.value = next
}

async function saveVolumeEdit() {
  if (!editingVolumeId.value || !editVolumeName.value.trim()) return
  await window.anovel.invoke('volume:update', editingVolumeId.value, {
    name: editVolumeName.value.trim(),
    description: editVolumeDesc.value.trim() || null
  })
  editingVolumeId.value = null
  await loadVolumes()
}

async function aiGenerateVolumes() {
  clearResult()
  parseError.value = ''
  const ctx = await window.anovel.invoke('context:buildWork', props.workId) as { text: string }
  lastContext.value = ctx.text
  await chat('请生成分卷大纲建议。', volumeSystemPrompt, 'volumes_outline', {
    workContextOptions: {
      includeVolumes: false,
      includeIncubator: true
    }
  })
}

async function runVolumeDiagnosis() {
  if (diagnosingVolumes.value) return
  diagnosingVolumes.value = true
  volumeDiagnosisResult.value = ''
  volumeDiagnosisError.value = ''
  showDiagnosisResult.value = true

  try {
    const ctx = await window.anovel.invoke('context:buildWork', props.workId, {
      includeIdea: true,
      includeCoreSettings: true,
      includeVolumes: true,
      includeIncubator: true,
      includeQualityIssues: true
    }) as { text: string }

    const userPrompt = `请对以下作品的分卷大纲进行逻辑与质量诊断：\n\n${ctx.text || '（暂无作品上下文）'}`

    const res = await window.anovel.invoke('model:chat', {
      prompt: userPrompt,
      systemPrompt: volumeDiagnosisSystemPrompt,
      workId: props.workId,
      step: 'volume_diagnose'
    }) as { success: boolean; content: string; error?: string }

    if (res.success) {
      volumeDiagnosisResult.value = res.content
    } else {
      volumeDiagnosisError.value = res.error || '诊断失败'
    }
  } catch (e) {
    volumeDiagnosisError.value = '诊断失败: ' + String(e)
  } finally {
    diagnosingVolumes.value = false
  }
}

async function runVolumeFix() {
  if (fixingVolumes.value || !volumeDiagnosisResult.value) return
  fixingVolumes.value = true
  volumeFixError.value = ''
  volumeFixResult.value = ''

  try {
    const volumesList = volumes.value.map(v => ({
      id: v.id,
      name: v.name,
      description: v.description || ''
    }))

    const userPrompt = [
      '【诊断报告】',
      volumeDiagnosisResult.value,
      '',
      '【当前分卷列表】',
      JSON.stringify(volumesList, null, 2),
      '',
      '请根据诊断报告对分卷进行修复，只输出 JSON patches。'
    ].join('\n')

    const res = await window.anovel.invoke('model:chat', {
      prompt: userPrompt,
      systemPrompt: volumeFixSystemPrompt,
      workId: props.workId,
      step: 'volume_diagnose_fix'
    }) as { success: boolean; content: string; error?: string }

    if (!res.success) {
      volumeFixError.value = res.error || '修复调用失败'
      return
    }

    const jsonText = extractJsonFromContent(res.content)
    if (!jsonText) {
      volumeFixError.value = '未能从 AI 回复解析出修复内容'
      return
    }

    let parsed: { patches?: { volumeId: number; name?: string; description?: string }[] }
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      volumeFixError.value = '修复 JSON 解析失败'
      return
    }

    if (!parsed.patches || parsed.patches.length === 0) {
      volumeFixResult.value = '诊断未发现需修复的问题，所有分卷已达标'
      volumeDiagnosisResult.value = ''
      showDiagnosisResult.value = false
      return
    }

    for (const patch of parsed.patches) {
      const fields: Record<string, unknown> = {}
      if (patch.name) fields.name = patch.name
      if (patch.description !== undefined) fields.description = patch.description
      if (Object.keys(fields).length > 0) {
        await window.anovel.invoke('volume:update', patch.volumeId, fields)
      }
    }

    await loadVolumes()
    volumeFixResult.value = `已修复 ${parsed.patches.length} 个分卷`
    volumeDiagnosisResult.value = ''
    volumeDiagnosisError.value = ''
    showDiagnosisResult.value = false
  } catch (e) {
    volumeFixError.value = '修复失败: ' + String(e)
  } finally {
    fixingVolumes.value = false
  }
}

function extractJsonFromContent(content: string): string | null {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()
  const braceStart = content.indexOf('{')
  if (braceStart >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = braceStart; i < content.length; i++) {
      const ch = content[i]
      if (inString) {
        if (escaped) { escaped = false; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return content.slice(braceStart, i + 1)
      }
    }
  }
  return null
}

async function applyParsedVolumes(mode: 'append' | 'replace') {
  if (parsedVolumes.value.length === 0 || applyingVolumes.value) return
  if (mode === 'replace' && volumes.value.length > 0) {
    if (!confirm(`将替换现有 ${volumes.value.length} 个分卷及其下属章节，确定继续？`)) return
  }
  applyingVolumes.value = true
  try {
    const items = parsedVolumes.value.map(v => ({
      name: v.name,
      description: v.description ?? ''
    }))
    await window.anovel.invoke('volume:batchUpsert', props.workId, items, mode)
    await loadVolumes()
    await nav?.refreshProgress()
    aiSuggestionExpanded.value = false
  } finally {
    applyingVolumes.value = false
  }
}

defineExpose({ loadVolumes })

function updateAiResult(content: string) {
  result.value = content
}

function aiSuggestionSummary(): string {
  if (parsedVolumes.value.length > 0) {
    return `已解析 ${parsedVolumes.value.length} 卷 · 点击展开查看详情`
  }
  const line = result.value?.split('\n').find(l => l.trim())?.trim() ?? ''
  return line.replace(/^#+\s*/, '').slice(0, 48) || 'AI 分卷建议'
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="book" title="分卷大纲" />
    <p class="text-sm text-base-content/50 mb-6">规划作品分卷结构，或使用 AI 根据核心设定生成分卷建议并一键应用。</p>

    <div class="flex flex-wrap gap-2 mb-4">
      <input
        v-model="newVolumeName"
        placeholder="分卷名称"
        class="input input-bordered flex-1 min-w-[200px]"
        @keyup.enter="addVolume"
      />
      <button class="btn btn-primary" :disabled="!newVolumeName.trim() || addingVolume" @click="addVolume">
        <font-awesome-icon v-if="addingVolume" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
        <font-awesome-icon v-else icon="plus" class="w-3.5 h-3.5 mr-1" />
        {{ addingVolume ? '添加中...' : '添加' }}
      </button>
      <button class="btn btn-outline btn-primary" :disabled="loading" @click="aiGenerateVolumes">
        <font-awesome-icon :icon="loading ? 'spinner' : 'robot'" :spin="loading" class="w-3.5 h-3.5 mr-1" />
        {{ loading ? '生成中...' : 'AI 生成分卷大纲' }}
      </button>
      <button class="btn btn-outline btn-warning gap-1" :disabled="diagnosingVolumes" @click="runVolumeDiagnosis">
        <font-awesome-icon :icon="diagnosingVolumes ? 'spinner' : 'stethoscope'" :spin="diagnosingVolumes" class="w-3.5 h-3.5" />
        {{ diagnosingVolumes ? '诊断中...' : '诊断大纲逻辑和质量' }}
      </button>
    </div>

    <div v-if="error" class="alert alert-error text-sm mb-4">{{ error }}</div>
    <div v-if="result" class="card bg-base-200 border border-base-300 shadow-sm mb-4">
      <div class="p-4 pb-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            class="flex items-center gap-2 min-w-0 text-left hover:opacity-80 transition-opacity"
            @click="aiSuggestionExpanded = !aiSuggestionExpanded"
          >
            <h4 class="font-semibold text-sm shrink-0">AI 分卷建议</h4>
            <span v-if="!aiSuggestionExpanded" class="text-xs text-base-content/50 truncate">
              {{ aiSuggestionSummary() }}
            </span>
            <font-awesome-icon
              :icon="aiSuggestionExpanded ? 'chevron-up' : 'chevron-down'"
              class="w-3 h-3 shrink-0 text-base-content/40"
            />
          </button>
          <div class="flex items-center gap-2 flex-wrap shrink-0">
            <template v-if="parsedVolumes.length">
              <span v-if="aiSuggestionExpanded" class="text-xs text-base-content/50">
                已解析 {{ parsedVolumes.length }} 卷
              </span>
              <button
                class="btn btn-primary btn-xs"
                :disabled="applyingVolumes"
                @click.stop="applyParsedVolumes('append')"
              >
                {{ applyingVolumes ? '应用中...' : '追加到分卷列表' }}
              </button>
              <button
                class="btn btn-outline btn-xs"
                :disabled="applyingVolumes"
                @click.stop="applyParsedVolumes('replace')"
              >
                替换现有分卷
              </button>
            </template>
            <span v-else-if="parseError" class="text-xs text-warning">{{ parseError }}</span>
            <span v-else class="text-xs text-warning">未能解析结构化分卷</span>
            <FavoriteButton
              :work-id="workId"
              source-step="volumes_outline"
              source-label="分卷大纲"
              :content="result"
              :source-input="lastContext"
              size="xs"
            />
          </div>
        </div>
      </div>
      <div v-show="aiSuggestionExpanded" class="px-4 pb-4 pt-0 space-y-3 border-t border-base-300/50">
        <div v-if="parseError" class="alert alert-warning text-xs py-2">{{ parseError }}</div>
        <div v-if="parsedVolumes.length" class="space-y-2">
          <p class="text-xs font-medium text-base-content/50">解析预览（将写入分卷列表）</p>
          <div
            v-for="(pv, idx) in parsedVolumes"
            :key="idx"
            class="text-xs bg-base-100 rounded-lg px-3 py-2 border border-base-300/60"
          >
            <div class="font-medium">{{ pv.name }}</div>
            <p class="text-base-content/60 mt-1 whitespace-pre-wrap line-clamp-4">{{ pv.description }}</p>
          </div>
        </div>
        <details v-if="!parsedVolumes.length && result">
          <summary class="text-xs cursor-pointer text-base-content/50 mb-2">查看原始 AI 输出</summary>
          <MarkdownContent :content="result" />
        </details>
        <details v-if="parsedVolumes.length && result" class="text-xs">
          <summary class="cursor-pointer text-base-content/50 mb-2">查看原始 JSON</summary>
          <pre class="whitespace-pre-wrap break-words text-[11px] opacity-70">{{ result }}</pre>
        </details>
        <AiInterventionBar
          :work-id="workId"
          step="volumes_outline"
          :content="result"
          regenerate-prompt="请生成分卷大纲建议。"
          :regenerate-system-prompt="volumeSystemPrompt"
          @update:content="updateAiResult"
        />
        <AiSelfCheckPanel :work-id="workId" step="volumes" :content="result" />
      </div>
    </div>

    <div v-if="showDiagnosisResult" class="card bg-base-200 border border-warning/30 shadow-sm mb-4">
      <div class="p-4">
        <div class="flex items-center justify-between gap-2 mb-3">
          <h4 class="font-semibold text-sm flex items-center gap-1.5">
            <font-awesome-icon icon="stethoscope" class="w-3.5 h-3.5 text-warning" />
            逻辑与质量诊断报告
            <span
              v-if="diagnosisConclusion"
              class="badge badge-sm"
              :class="{
                'badge-success': diagnosisConclusion === 'PASS',
                'badge-warning': diagnosisConclusion === 'REVISE',
                'badge-error': diagnosisConclusion === 'FAIL'
              }"
            >{{ diagnosisConclusion }}</span>
          </h4>
          <div class="flex items-center gap-2">
            <button
              v-if="volumeDiagnosisResult && hasFixableIssues && !fixingVolumes"
              class="btn btn-primary btn-xs gap-1"
              @click="runVolumeFix"
            >
              <font-awesome-icon icon="wrench" class="w-3 h-3" />
              应用修复
            </button>
            <button class="btn btn-ghost btn-xs gap-1" @click="showDiagnosisResult = false">
              <font-awesome-icon icon="times" class="w-3 h-3" />
              关闭
            </button>
          </div>
        </div>
        <div v-if="volumeDiagnosisError" class="alert alert-error text-sm">{{ volumeDiagnosisError }}</div>
        <div v-else-if="diagnosingVolumes" class="text-sm text-base-content/50 flex items-center gap-2">
          <font-awesome-icon icon="spinner" spin class="w-4 h-4" />
          诊断中，请稍候...
        </div>
        <MarkdownContent v-else-if="volumeDiagnosisResult && !fixingVolumes" :content="volumeDiagnosisResult" />
        <div v-else-if="fixingVolumes" class="text-sm text-base-content/50 flex items-center gap-2">
          <font-awesome-icon icon="spinner" spin class="w-4 h-4" />
          正在根据诊断结果修复分卷大纲...
        </div>
        <div v-else-if="volumeFixError" class="alert alert-error text-sm">{{ volumeFixError }}</div>
        <div v-else-if="volumeFixResult" class="text-sm text-success">
          修复完成：{{ volumeFixResult }}
        </div>
      </div>
    </div>

    <div class="card bg-base-200 border border-base-300 shadow-sm">
      <div class="px-4 py-3 border-b border-base-300/50">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h4 class="font-semibold text-sm">分卷列表</h4>
            <p v-if="volumes.length" class="text-xs text-base-content/50 mt-0.5">共 {{ volumes.length }} 卷</p>
          </div>
          <div v-if="volumes.length" class="flex items-center gap-2">
            <button
              type="button"
              class="btn btn-outline btn-error btn-xs gap-1"
              @click="openReplanModal"
            >
              <font-awesome-icon icon="rotate" class="w-3 h-3" />
              重新规划整本
            </button>
            <button
              type="button"
              class="btn btn-outline btn-xs gap-1"
              :class="batchSelectMode ? 'btn-error' : 'btn-neutral'"
              @click="toggleBatchSelect"
            >
              <font-awesome-icon icon="check-double" class="w-3 h-3" />
              {{ batchSelectMode ? '退出批量' : '批量操作' }}
            </button>
          </div>
        </div>
        <div v-if="batchSelectMode" class="flex items-center gap-2 mt-2">
          <button type="button" class="btn btn-ghost btn-xs" @click="selectAllVolumes">
            {{ batchSelectedIds.size === volumes.length ? '取消全选' : '全选' }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-xs"
            :disabled="batchSelectedIds.size === 0"
            @click="batchDeleteVolumes"
          >
            <font-awesome-icon icon="trash" class="w-3 h-3 mr-1" />
            删除 ({{ batchSelectedIds.size }})
          </button>
        </div>
      </div>
      <div class="px-4 pb-4 pt-3">
        <div v-if="volumes.length === 0" class="text-center py-12 text-base-content/40">
          <font-awesome-icon icon="book" class="text-4xl mb-3 opacity-30" />
          <p>还没有分卷</p>
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="vol in volumes"
            :key="vol.id"
            class="card bg-base-100 border shadow-sm overflow-hidden"
            :class="[
              isInvalidVolumeName(vol.name) ? 'border-warning/50' : 'border-base-300',
              batchSelectMode && batchSelectedIds.has(vol.id) ? '!border-error/40 !bg-error/5' : ''
            ]"
          >
            <div v-if="editingVolumeId === vol.id" class="p-4 space-y-2">
              <input v-model="editVolumeName" class="input input-bordered input-sm w-full" placeholder="分卷名称" />
              <textarea
                v-model="editVolumeDesc"
                rows="3"
                class="textarea textarea-bordered w-full textarea-sm resize-none"
                placeholder="分卷说明（主题、冲突、钩子...）"
              />
              <div class="flex gap-2">
                <button class="btn btn-primary btn-xs" @click="saveVolumeEdit">保存</button>
                <button class="btn btn-ghost btn-xs" @click="editingVolumeId = null">取消</button>
              </div>
            </div>
            <template v-else>
              <div class="flex items-center justify-between gap-2 px-4 py-3">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <input
                    v-if="batchSelectMode"
                    type="checkbox"
                    class="checkbox checkbox-xs checkbox-error shrink-0"
                    :checked="batchSelectedIds.has(vol.id)"
                    @click.stop="toggleBatchItem(vol.id)"
                  />
                  <button
                    type="button"
                    class="flex items-center gap-2 min-w-0 text-left hover:opacity-80 transition-opacity"
                    @click="batchSelectMode ? toggleBatchItem(vol.id) : toggleVolumeExpanded(vol.id)"
                  >
                    <h4 class="font-semibold text-sm truncate flex items-center gap-1">
                      <span class="truncate">{{ vol.name }}</span>
                      <span v-if="isInvalidVolumeName(vol.name)" class="badge badge-warning badge-xs shrink-0">无效</span>
                    </h4>
                    <font-awesome-icon
                      v-if="!batchSelectMode"
                      :icon="isVolumeExpanded(vol.id) ? 'chevron-up' : 'chevron-down'"
                      class="w-3 h-3 shrink-0 text-base-content/40"
                    />
                  </button>
                </div>
                <div v-if="!batchSelectMode" class="flex gap-1 shrink-0">
                  <button class="btn btn-ghost btn-xs gap-1" @click.stop="startEditVolume(vol)">
                    <font-awesome-icon icon="edit" class="w-3 h-3" />
                    编辑
                  </button>
                  <button class="btn btn-ghost btn-xs text-error gap-1" @click.stop="deleteVolume(vol.id, vol.name)">
                    <font-awesome-icon icon="trash" class="w-3 h-3" />
                    删除
                  </button>
                </div>
              </div>
              <div
                v-show="!batchSelectMode && isVolumeExpanded(vol.id)"
                class="px-4 pb-4 pt-0 border-t border-base-300/50"
              >
                <p v-if="vol.description" class="text-sm text-base-content/50 mt-3 whitespace-pre-wrap">{{ vol.description }}</p>
                <p v-else class="text-xs text-base-content/30 mt-3 italic">暂无分卷说明，点击编辑添加</p>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <dialog class="modal" :class="{ 'modal-open': replanModalOpen }">
      <div class="modal-box max-w-xl">
        <h3 class="font-bold text-lg">重新规划整本小说</h3>
        <p class="mt-2 text-sm text-base-content/65">
          该操作不是普通删除：系统会先保存数据库备份和可导入作品备份，然后一次性清理全部分卷、章节正文、历史版本、因果状态、资源账本和目标循环检查点。
        </p>

        <div v-if="replanLoading && !replanPreview" class="py-8 text-center text-base-content/50">
          <span class="loading loading-spinner loading-sm mr-2" />正在核对可删除范围…
        </div>

        <template v-else-if="replanPreview">
          <div class="alert alert-warning mt-4 text-sm">
            <div>
              <div class="font-semibold">将清理 {{ replanPreview.volumeCount }} 卷、{{ replanPreview.chapterCount }} 章</div>
              <div class="mt-1 opacity-80">
                其中 {{ replanPreview.bodyChapterCount }} 章已有正文，共 {{ replanPreview.totalWordCount.toLocaleString() }} 字；
                {{ replanPreview.authorityDecisionCount }} 个权威章节事务也会重置。
              </div>
            </div>
          </div>

          <div class="mt-5 space-y-2">
            <div class="text-sm font-semibold">新一轮保留哪些设定？</div>
            <label class="flex gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 cursor-pointer">
              <input v-model="replanSettingsMode" type="radio" value="preserve" class="radio radio-primary radio-sm mt-0.5" />
              <span>
                <span class="block text-sm font-medium">保留核心设定（推荐）</span>
                <span class="block text-xs text-base-content/60 mt-1">保留人物、世界观、金手指、主线、角色卡、灵感和文风，只重做分卷与章节。</span>
              </span>
            </label>
            <label class="flex gap-3 rounded-lg border border-base-300 p-3 cursor-pointer">
              <input v-model="replanSettingsMode" type="radio" value="regenerate" class="radio radio-error radio-sm mt-0.5" />
              <span>
                <span class="block text-sm font-medium">重新生成核心设定</span>
                <span class="block text-xs text-base-content/60 mt-1">只保留作品基本信息、初始灵感和文风；清空其他核心设定、角色卡、锚点与名称登记。</span>
              </span>
            </label>
          </div>

          <div class="form-control mt-5">
            <label class="label"><span class="label-text text-sm">输入作品名确认</span></label>
            <div class="rounded bg-base-200 px-3 py-2 text-sm font-medium select-all">{{ currentWorkTitle }}</div>
            <input
              v-model="replanConfirmationTitle"
              class="input input-bordered mt-2"
              :placeholder="currentWorkTitle"
              autocomplete="off"
            />
          </div>

          <div v-if="replanError" class="alert alert-error mt-4 text-sm">{{ replanError }}</div>
          <div v-if="replanResult" class="alert alert-success mt-4 text-sm">
            <div class="min-w-0">
              <div class="font-semibold">重新规划准备完成，当前作品已回到设定检查阶段。</div>
              <div class="mt-2 break-all">数据库备份：{{ replanResult.databaseBackupPath }}</div>
              <div class="mt-1 break-all">作品备份：{{ replanResult.workBackupPath }}</div>
            </div>
          </div>
        </template>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost" :disabled="replanLoading" @click="closeReplanModal">
            {{ replanResult ? '完成' : '取消' }}
          </button>
          <button
            v-if="!replanResult"
            type="button"
            class="btn btn-error"
            :disabled="!canConfirmReplan"
            @click="confirmReplanReset"
          >
            <span v-if="replanLoading" class="loading loading-spinner loading-sm" />
            备份并重新规划
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @submit.prevent="closeReplanModal">
        <button type="submit">关闭</button>
      </form>
    </dialog>

    <StepNavFooter step="volumes" class="mt-4" />
  </div>
</template>
