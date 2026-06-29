<script setup lang="ts">
import { ref, computed } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import type { ModelChatResult } from '../useModelChat'
import { reportRendererError } from '../../utils/reportError'
import { getIncubatorSlotLabel, isIncubatorSlotKey } from '../../../../shared/incubator-slots'
import {
  EMPTY_STORY_CATEGORY_TAGS,
  STORY_CHARACTER_TAGS,
  STORY_EMOTION_TAGS,
  STORY_MAIN_CATEGORIES,
  STORY_PLOT_TAGS,
  STORY_SETTING_TAGS,
  flattenStoryCategoryTags,
  normalizeStoryCategoryTags,
  parseStoryCategoryTagsFromWork,
  storyCategoryPromptSection,
  storyCategoryTagsToStorage,
  type StoryCategoryTags
} from '../../../../shared/story-category-tags'
import { STORY_HOT_WORD_GROUPS, storyHotWordPromptSection } from '../../../../shared/story-hot-words'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)
const emit = defineEmits<{ changed: [] }>()

const workType = ref<string>('novel')
const isStory = computed(() => workType.value === 'story')

type TitleHookCandidate = {
  title: string
  hook: string
  type: string
  summary: string
  tags: StoryCategoryTags
}

const loading = ref(false)
const error = ref('')
const candidates = ref<TitleHookCandidate[]>([])
const workInfo = ref<{ title: string; description: string | null; genre: string | null; tags: string | null } | null>(null)

async function loadWorkInfo() {
  const w = await window.anovel.invoke('work:get', props.workId) as { title: string; description: string | null; genre: string | null; tags: string | null; work_type?: string }
  workInfo.value = w
  workType.value = w.work_type ?? 'novel'
}

const seedText = ref('')
const selectedType = ref('all')

const TEMPLATES = [
  { value: 'all', label: '随机生成（混合所有风格）' },
  { value: 'straight', label: '直白爽点型（如：未婚夫亲妈消费38万逼我结账？我当场报警）' },
  { value: 'contrast', label: '反差对立型（如：怀孕当天被离婚，我亮出家底吓懵他）' },
  { value: 'suspense', label: '悬念留白型（如：高考前夜，班主任让我千万别在答题卡上写名字）' },
  { value: 'scene', label: '场景直击型（如：偷刷我会员卡请客？我反手销卡，你自己买单吧）' },
  { value: 'ip', label: 'IP质感型（如：太子侧妃生存手册、被首辅娇养后）' }
]

const tagGroups = [
  { key: 'plot', label: '情节', options: STORY_PLOT_TAGS },
  { key: 'character', label: '角色', options: STORY_CHARACTER_TAGS },
  { key: 'emotion', label: '情绪', options: STORY_EMOTION_TAGS },
  { key: 'setting', label: '背景', options: STORY_SETTING_TAGS }
] as const

const currentTags = computed(() => workInfo.value ? parseStoryCategoryTagsFromWork(workInfo.value.genre, workInfo.value.tags) : { ...EMPTY_STORY_CATEGORY_TAGS })
const currentFlatTags = computed(() => flattenStoryCategoryTags(currentTags.value))

function normalizeCandidate(raw: unknown): TitleHookCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const hook = typeof row.hook === 'string' ? row.hook.trim() : ''
  if (!title || !hook) return null
  const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
  const fallbackText = [title, hook, summary].join('\n')
  return {
    title,
    hook,
    type: typeof row.type === 'string' ? row.type.trim() : '',
    summary,
    tags: normalizeStoryCategoryTags(row.tags, fallbackText)
  }
}

function toggleTag(c: TitleHookCandidate, key: keyof Omit<StoryCategoryTags, 'main_category'>, tag: string) {
  const list = c.tags[key]
  const idx = list.indexOf(tag)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(tag)
}

function selectedTagText(c: TitleHookCandidate): string {
  const items = flattenStoryCategoryTags(c.tags)
  return items.length ? items.join(' · ') : '未选择'
}

async function saveTagsOnly(tags: StoryCategoryTags) {
  await window.anovel.invoke('work:update', props.workId, {
    genre: tags.main_category || null,
    tags: storyCategoryTagsToStorage(tags)
  })
  await loadWorkInfo()
  emit('changed')
}

async function generate() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  
  try {
    const chapters = await window.anovel.invoke('chapter:listByWork', props.workId) as { 
      title: string 
      outline: string | null 
      volume_name: string 
    }[]

    const incubatorState = await window.anovel.invoke('incubator:getState', props.workId) as { 
      activeDraftSlots: { slotKey: string, content: string }[] 
    }
    const workDetails = await window.anovel.invoke('work:get', props.workId) as { work_type?: string; genre?: string | null; tags?: string | null }
    const wt = workDetails?.work_type || 'novel'
    workType.value = wt
    const baseTags = parseStoryCategoryTagsFromWork(workDetails?.genre ?? workInfo.value?.genre, workDetails?.tags ?? workInfo.value?.tags)

    const slotsContext = incubatorState.activeDraftSlots
      .filter(s => s.content && s.content.trim())
      .map(s => {
        const label = isIncubatorSlotKey(s.slotKey) 
          ? getIncubatorSlotLabel(s.slotKey, workType) 
          : s.slotKey
        return `## ${label}\n${s.content.trim()}`
      })
      .join('\n\n')

    const volumesMap: Record<string, typeof chapters> = {}
    for (const ch of chapters) {
      if (!volumesMap[ch.volume_name]) {
        volumesMap[ch.volume_name] = []
      }
      volumesMap[ch.volume_name].push(ch)
    }

    let outlineContext = ''
    const volumeNames = Object.keys(volumesMap)
    if (volumeNames.length === 1 && (volumeNames[0] === '正文' || volumeNames[0] === '正文卷')) {
      outlineContext = volumesMap[volumeNames[0]]
        .filter(c => c.outline && c.outline.trim())
        .map(c => `### ${c.title}\n${c.outline}`)
        .join('\n\n')
    } else {
      outlineContext = volumeNames
        .map(volName => {
          const chsText = volumesMap[volName]
            .filter(c => c.outline && c.outline.trim())
            .map(c => `  - ${c.title}：${c.outline}`)
            .join('\n')
          return chsText ? `## ${volName}\n${chsText}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
    }

    const prompt = `
【大纲孵化内容】
${slotsContext || '（暂无大纲孵化内容）'}

【各章节/节拍情节大纲】
${outlineContext || '（暂无章节大纲内容，请先在章节/节拍中编写大纲）'}

【当前作品分类标签】
主分类：${baseTags.main_category || '未选择'}
其他标签：${flattenStoryCategoryTags(baseTags).filter(t => t !== baseTags.main_category).join('、') || '未选择'}

【故事核心与补充要求】
${seedText.value.trim() || '（无额外补充）'}
    `.trim()

    const typeLabel = TEMPLATES.find(t => t.value === selectedType.value)?.label || '随机生成（混合所有风格）'
    const channelLabel = isStory.value ? '短故事频道' : '小说频道'
    const workTypeLabel = isStory.value ? '短故事' : '小说'

    const systemPrompt = `你是番茄小说网${channelLabel}的顶流爆款编辑，深谙番茄${workTypeLabel}的爆款流量密码。你的核心任务是：基于番茄小说网爆款书名与导语的创作方法论，结合用户提供的大纲孵化设定、章节大纲以及核心要求，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的【${workTypeLabel}书名与导语】组合。

【生成风格偏好】
当前偏好的风格类型为：${typeLabel}。生成时请高度契合该类型的风格内核。

【书名要求 — 番茄爆款书名五要素】
书名是读者"点进来"的第一道门面，必须严格遵循以下五大核心要素：
1. 精准赛道标签，适配流量池：书名自带品类关键词（甜宠/虐文/悬疑/重生/逆袭/打脸/穿书等），让读者一眼识别赛道，避免标签模糊导致故事被"蒙尘"。
2. 强冲突反差，制造记忆点：通过身份、境遇、结局的反差制造戏剧感，书名提前铺垫冲突，在平铺直叙的书名中脱颖而出。
3. 语言接地气，适配阅读语境：多用口语化表达，适配网络阅读语境，避免文言文、生僻词汇，降低读者理解门槛。
4. 预留悬念缺口，勾起好奇心：适当留白，不把结局亮点全部说透，留下疑问空间，让读者产生"想点开看看"的冲动。
5. 戳中大众情绪，引发共鸣：贴合读者爽点、痛点、虐点、笑点（逆袭爽感、追妻火葬场、反转打脸、遗憾救赎等），充分调动阅读欲望。

【五种书名类型及番茄爆款范例】
- 直白爽点型（适配爽文/打脸/逆袭）：直接抛出人物矛盾、对立关系、核心爽点，增强代入感。
  范例：《邻居盖房子不留出路，我反手挖鱼塘》《未婚夫亲妈消费38万逼我结账？我当场报警》《被换了人生后，我成了京圈皇太女的继女》
- 反差对立型（适配言情/甜宠/虐恋/逆袭/重生）：打造身份、性格、处境的反差，突出核心爽点。
  范例：《怀孕当天被离婚，我亮出家底吓懵他》《被送去和亲后，我选择摆烂，暴君傻眼了》《穿成修仙文女配后，我摆烂了》
- 悬念留白型（适配悬疑/脑洞/奇幻/强反转）：用问句、留白制造悬念，只抛问题不揭答案，勾起探索欲。
  范例：《高考前夜，班主任让我千万别在答题卡上写名字》《第一次带女友回家，我妈：她不对劲》《别跑了，这阎王是我失踪十年的亲爸》
- 场景直击型（全题材通用）：截取名场面/高光，用动作和场景构建画面，让读者身临其境。
  范例：《偷刷我会员卡请客？我反手销卡，你自己买单吧》《我把发给亲哥的消息错发给了老板》
- IP质感型（适配虐恋/古言/宫斗宅斗/甜宠/双男主等IP向）：以简约质感、具有画面感/氛围感的短句为主，让人一眼看出IP潜力。
  范例：《太子侧妃生存手册》《校花她重走花路》《被首辅娇养后》

【导语要求 — 番茄爆款导语四要素】
导语是留住读者的关键"帧"，必须严格遵循以下四大核心要素：

1. 开篇即冲突，无废话铺垫：严禁冗长的背景介绍、人物铺垫或环境描写！第一句话直接切入矛盾、危机、反转或名场面，把握前三行黄金留存区，用冲击力情节抓住眼球。
2. 人设清晰立体，快速代入：寥寥数语立住角色灵魂，简练交代主角身份、处境、性格，通过一个亮眼的动作或金句展现人物魅力，让读者快速代入主角视角、同频共振。
3. 埋设强钩子，提升追读欲：开篇抛出引人入胜的悬念、意想不到的反转或直击痛点的爽感，巧妙留下待揭晓的核心答案或即将爆发的高光时刻，像钩子一样牵引好奇心。
4. 紧贴故事主线，统一高光亮点：导语内容紧扣书名核心亮点展开，笔墨聚焦主线发展，确保书名、导语和正文高潮保持一致，不铺垫无关剧情。

【番茄爆款导语范例】
范例1·《听懂婴语后，我成了整个豪门圈的座上宾》：
"这孩子是先天性神经衰弱，治不好了，准备后事吧。"顶级专家李主任摇着头，给首富家的金孙下了病危通知书。首富夫人当场哭晕，全家乱成一锅粥。而我脑子里却响起了一道字正腔圆的暴躁奶音："胡说！本宝宝明明是被衣服后领的纯金标签扎到肉了！"我深吸一口气，顶着保镖杀人的目光，一把扯开了小少爷那件价值十万的高定婴儿服。
（信息差+反差萌喜剧冲突+无视豪门威压果断出手=爽感落地+悬念钩子）

范例2·《月上枝头做凤凰》：
在进宫前一夜，我的母亲在我面前痛哭流涕："祁月，皇上比明珠足足大了二十岁啊，你叫我怎么舍得她进宫受苦啊。"我的哥哥第一次心平气和的和我说话，"明珠单纯，不似你那么深沉，你就代替她入宫吧。"我的父亲冷漠的看着我，没有说一句话。我面无表情的看着他们，我唯一的家人。"那我呢，我还比宋明珠小一岁呢。""你们就不怕我一辈子被困在那吗？"那一夜，我躺在床上想着，要不进宫后刺杀皇上，为他们谋个灭九族的前途。
（替嫁核心冲突+家人冷漠vs主角反击的反差+极端内心独白=情绪爆发+悬念拉满）

【导语写作规范】
- 限制在 150-300 字，推荐第一人称叙述，语气鲜明（冷酷/嘲弄/笃定/轻松等，视题材而定），增强代入感。
- 去除任何温吞的AI腔调，模拟番茄爆款${workTypeLabel}的真实文风。

${storyHotWordPromptSection()}

${storyCategoryPromptSection()}

【输出要求】
必须且只能输出合法的 JSON，不要使用 Markdown 代码块包裹，结构如下：
{
  "candidates": [
    {
      "title": "书名",
      "hook": "导语正文",
      "type": "直白爽点型 / 反差对立型 / 悬念留白型 / 场景直击型 / IP质感型",
      "summary": "一句点评：分析该组合如何运用番茄爆款五要素抓住读者，书名与导语如何配合形成追读冲动",
      "tags": {
        "main_category": "主分类，只能一个",
        "plot": ["情节分类，可为空数组"],
        "character": ["角色分类，可为空数组"],
        "emotion": ["情绪分类，可为空数组"],
        "setting": ["背景分类，可为空数组"]
      }
    }
  ]
}
`

    const res = await window.anovel.invoke('model:chat', {
      prompt,
      systemPrompt,
      workId: props.workId,
      step: isStory.value ? 'story_title_hook_gen' : 'novel_title_hook_gen',
      enrichWorkContext: false,
      ...bodyModelParams()
    }) as ModelChatResult

    if (!res.success) {
      throw new Error(res.error || '生成失败')
    }

    const text = res.content.trim()
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
    const jsonStr = match ? (match[1] || match[0]) : text
    const parsed = JSON.parse(jsonStr)

    if (parsed && Array.isArray(parsed.candidates)) {
      candidates.value = parsed.candidates
        .map(normalizeCandidate)
        .filter((x: TitleHookCandidate | null): x is TitleHookCandidate => x != null)
    } else {
      throw new Error('JSON 解析格式错误')
    }
  } catch (e) {
    error.value = String(e)
    await reportRendererError('story', `生成书名导语失败: ${error.value}`, { workId: props.workId })
  } finally {
    loading.value = false
  }
}

async function applyCandidate(c: TitleHookCandidate) {
  try {
    await window.anovel.invoke('work:update', props.workId, {
      title: c.title,
      description: c.hook,
      genre: c.tags.main_category || null,
      tags: storyCategoryTagsToStorage(c.tags)
    })
    await loadWorkInfo()
    emit('changed')
    alert('已成功应用书名、导语和作品标签！')
  } catch (e) {
    alert(`应用失败：${String(e)}`)
  }
}

loadWorkInfo()
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4 w-full">
    <div class="flex items-start justify-between mb-4">
      <div>
        <h4 class="font-semibold flex items-center gap-2">
          <font-awesome-icon icon="heading" class="w-3.5 h-3.5 text-primary shrink-0" />
          爆款书名与导语生成
        </h4>
        <p class="text-xs text-base-content/40 mt-0.5">基于番茄小说网爆款方法论，从故事大纲批量生成吸睛书名与导语。</p>
      </div>
    </div>

    <div v-if="workInfo" class="mb-4 p-3 bg-base-100 rounded border border-base-300">
      <p class="text-xs text-base-content/50 mb-1">当前作品书名与导语：</p>
      <p class="font-bold text-sm text-primary mb-1">{{ workInfo.title }}</p>
      <p class="text-xs text-base-content/70 whitespace-pre-wrap">{{ workInfo.description || '（暂无导语）' }}</p>
      <div class="mt-2 pt-2 border-t border-base-300/60">
        <p class="text-xs text-base-content/50 mb-1">当前作品标签：</p>
        <div class="flex flex-wrap gap-1.5">
          <span v-if="!currentFlatTags.length" class="text-xs text-base-content/40">（暂无标签）</span>
          <span v-for="tag in currentFlatTags" :key="tag" class="badge badge-outline badge-xs">{{ tag }}</span>
        </div>
      </div>
    </div>

    <div class="space-y-3 mb-4">
      <div class="p-3 rounded border border-base-300 bg-base-100/70">
        <div class="text-xs font-medium text-base-content/60 mb-2">短篇爆款热词参考</div>
        <div class="space-y-1.5">
          <div v-for="group in STORY_HOT_WORD_GROUPS" :key="group.label" class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-base-content/40 w-14 shrink-0">{{ group.label }}</span>
            <span v-for="word in group.words" :key="word" class="badge badge-outline badge-xs">{{ word }}</span>
          </div>
        </div>
      </div>
      <textarea
        v-model="seedText"
        class="textarea textarea-bordered w-full text-sm leading-relaxed"
        placeholder="可输入额外补充要求（如：想突出女主冷酷复仇、强调男主的绿茶属性...）"
        rows="2"
      ></textarea>

      <div class="flex items-center gap-2">
        <select v-model="selectedType" class="select select-bordered select-sm flex-1">
          <option v-for="t in TEMPLATES" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <button
          class="btn btn-primary btn-sm gap-1"
          :disabled="loading"
          @click="generate"
        >
          <font-awesome-icon :icon="loading ? 'spinner' : 'robot'" :spin="loading" class="w-3.5 h-3.5" />
          {{ loading ? '生成中...' : '生成候选' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error text-xs py-2 mb-3">
      {{ error }}
    </div>

    <div v-if="candidates.length" class="space-y-4">
      <div v-for="(c, i) in candidates" :key="i" class="border border-base-300 rounded-lg p-3 bg-base-100 relative">
        <div class="flex justify-between items-start gap-2 mb-2">
          <div class="min-w-0 pr-16">
            <h5 class="font-bold text-sm text-primary">{{ c.title }}</h5>
            <span class="text-[10px] text-base-content/50 border border-base-content/20 px-1.5 py-0.5 rounded">{{ c.type }}</span>
          </div>
          <button class="btn btn-outline btn-primary btn-xs absolute top-3 right-3" @click="applyCandidate(c)">
            应用
          </button>
        </div>
        <p class="text-xs text-base-content/70 italic mb-2">点评：{{ c.summary }}</p>
        <div class="mb-2 p-2 rounded border border-base-300/60 bg-base-200/30 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-medium text-base-content/60">作品标签</div>
            <button type="button" class="btn btn-ghost btn-xs" @click="saveTagsOnly(c.tags)">仅应用标签</button>
          </div>
          <label class="form-control w-full">
            <span class="label-text text-[11px] text-base-content/50 mb-1">主分类（单选）</span>
            <select v-model="c.tags.main_category" class="select select-bordered select-xs w-full">
              <option value="">请选择</option>
              <option v-for="item in STORY_MAIN_CATEGORIES" :key="item.value" :value="item.value">
                {{ item.label }} · {{ item.gender }}
              </option>
            </select>
          </label>
          <div v-for="group in tagGroups" :key="group.key" class="space-y-1">
            <div class="text-[11px] text-base-content/50">{{ group.label }}分类（可多选）</div>
            <div class="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
              <button
                v-for="tag in group.options"
                :key="tag"
                type="button"
                class="badge badge-xs cursor-pointer select-none"
                :class="c.tags[group.key].includes(tag) ? 'badge-primary' : 'badge-outline'"
                @click="toggleTag(c, group.key, tag)"
              >
                {{ tag }}
              </button>
            </div>
          </div>
          <p class="text-[11px] text-base-content/40 line-clamp-2">已选：{{ selectedTagText(c) }}</p>
        </div>
        <div class="bg-base-200/50 p-2 rounded text-sm text-base-content/80 whitespace-pre-wrap leading-relaxed border border-base-300/50">
          {{ c.hook }}
        </div>
      </div>
    </div>
  </div>
</template>
