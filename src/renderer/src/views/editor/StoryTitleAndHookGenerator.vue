<script setup lang="ts">
import { ref, computed } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import type { ModelChatResult } from '../useModelChat'
import { reportRendererError } from '../../utils/reportError'
import { getIncubatorSlotLabel, isIncubatorSlotKey } from '../../../../shared/incubator-slots'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)
const emit = defineEmits<{ changed: [] }>()

const loading = ref(false)
const error = ref('')
const candidates = ref<{ title: string; hook: string; type: string; summary: string }[]>([])
const workInfo = ref<{ title: string; description: string | null } | null>(null)

async function loadWorkInfo() {
  workInfo.value = await window.anovel.invoke('work:get', props.workId) as { title: string; description: string | null }
}

const seedText = ref('')
const selectedType = ref('all')

const TEMPLATES = [
  { value: 'all', label: '随机生成（混合所有风格）' },
  { value: 'straight', label: '直白爽点型（如：被全家抛弃后，我被京圈大佬宠上天）' },
  { value: 'contrast', label: '反差对立型（如：清冷师尊的白月光竟是合欢宗妖女）' },
  { value: 'suspense', label: '悬念留白型（如：他死后的第三年，我收到了他的结婚请柬）' },
  { value: 'scene', label: '场景直击型（如：捉奸在床那天，我顺手点了个月嫂）' }
]

async function generate() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  
  try {
    // 获取作品下的所有章节大纲
    const chapters = await window.anovel.invoke('chapter:listByWork', props.workId) as { 
      title: string 
      outline: string | null 
      volume_name: string 
    }[]

    // 拉取大纲孵化（Storyline Incubator）的内容
    const incubatorState = await window.anovel.invoke('incubator:getState', props.workId) as { 
      activeDraftSlots: { slotKey: string, content: string }[] 
    }
    const workDetails = await window.anovel.invoke('work:get', props.workId) as { work_type?: string }
    const workType = workDetails?.work_type || 'novel'

    const slotsContext = incubatorState.activeDraftSlots
      .filter(s => s.content && s.content.trim())
      .map(s => {
        const label = isIncubatorSlotKey(s.slotKey) 
          ? getIncubatorSlotLabel(s.slotKey, workType) 
          : s.slotKey
        return `## ${label}\n${s.content.trim()}`
      })
      .join('\n\n')

    // 按分卷分组整理章节大纲
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

【故事核心与补充要求】
${seedText.value.trim() || '（无额外补充）'}
    `.trim()

    const typeLabel = TEMPLATES.find(t => t.value === selectedType.value)?.label || '随机生成（混合所有风格）'

    const systemPrompt = `
你是番茄短故事的顶流爆款编辑，深谙爆款流量密码。你的核心任务是：从【人性的弱点】（窥私欲、虚荣心、嫉妒心、贪婪、愤怒、复仇欲、恐惧）出发，基于用户提供的大纲孵化设定、章节大纲以及核心要求，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的【短故事书名与导语】组合。

【生成风格偏好】
当前偏好的风格类型为：${typeLabel}。生成时请高度契合该类型的风格内核。

【书名要求 - 直击人性弱点】
- **贪婪与爽感**：展现极速的反击、地位逆袭（如：“被全家扫地出门后，我继承了千亿家产”、“豪门真千金觉醒后，干翻了全员”）。
- **窥私与反差**：撕开体面人的伪装，展现极致的反差（如：“高冷清秀的学霸同桌，私底下竟在做擦边主播”、“在公司克己奉公的科长，晚上却在酒吧当男模”）。
- **愤怒与嫉妒**：点燃读者对背叛、极品反派的怒火，并预留绝对清算的爽快悬念（如：“姐姐抢走我的窃运系统，高考出分那天她崩溃了”、“被恶毒婆婆欺压三年，我直接成了她顶头上司的夫人”）。
- **猎奇与恐惧**：构建充满悬念和诡异的情境，利用读者的未知欲（如：“邻居死后的第十天，敲门声再次响起”、“千万不要点外卖的第七道菜”）。
- 必须采用强网感结构，多用否定句、极具挑衅感的断句或引发极度好奇的对比。

【导语要求（Hook） - 炸裂式黄金开局】
- **前三句必须爆发冲突**：严禁任何背景铺垫、世界观解说或无关的环境描写！直接从最隐私、最难堪、最刺激或最愤怒的切入点“开火”（例如：“捉奸在床那天，我没哭，反而仔细拍下了他们的姿势...”；“当婆婆把一碗馊了的剩饭倒在我头上时，我笑了...”）。
- **极致拉扯人性的弱点**：
  - **窥私欲**：让读者以第一人称视角窥视到主角的隐秘底牌或反派的虚伪嘴脸。
  - **憋屈与愤怒**：把反派的极品行为写得极其露骨和令人发指（点燃嫉妒与愤怒），同时暗示主角手握信息差或降维金手指。
  - **悬念与勾引**：在导语的最后 1-2 句留下一个**让读者心跳停止、必须点开正文寻找答案的悬念钩子**（例如：“我微笑着按下了发送键，游戏正式开始。”；“可是他们不知道，我此时正通过镜子，静静地看着他们。”）。
- 必须限制在 150-300 字，全篇采用第一人称（“我”）叙述，语气必须强烈、冷酷、嘲弄或极度笃定，增强代入感，去除任何温吞的AI腔调。

【输出要求】
必须且只能输出合法的 JSON，不要使用 Markdown 代码块包裹，结构如下：
{
  "candidates": [
    {
      "title": "书名",
      "hook": "导语正文",
      "type": "直白爽点型 / 反差对立型 / 悬念留白型 / 场景直击型",
      "summary": "一句点评：它是如何直击哪个人性弱点，又是如何通过黄金三句拉满读者留存的"
    }
  ]
}
`

    const res = await window.anovel.invoke('model:chat', {
      prompt,
      systemPrompt,
      workId: props.workId,
      step: 'story_title_hook_gen',
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

async function applyCandidate(c: { title: string; hook: string }) {
  try {
    await window.anovel.invoke('work:update', props.workId, { 
      title: c.title, 
      description: c.hook 
    })
    await loadWorkInfo()
    emit('changed')
    alert('已成功应用书名和导语！')
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
        <p class="text-xs text-base-content/40 mt-0.5">短故事的吸量灵魂，基于故事大纲批量生成吸睛书名与导语。</p>
      </div>
    </div>

    <div v-if="workInfo" class="mb-4 p-3 bg-base-100 rounded border border-base-300">
      <p class="text-xs text-base-content/50 mb-1">当前作品书名与导语：</p>
      <p class="font-bold text-sm text-primary mb-1">{{ workInfo.title }}</p>
      <p class="text-xs text-base-content/70 whitespace-pre-wrap">{{ workInfo.description || '（暂无导语）' }}</p>
    </div>

    <div class="space-y-3 mb-4">
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
        <div class="bg-base-200/50 p-2 rounded text-sm text-base-content/80 whitespace-pre-wrap leading-relaxed border border-base-300/50">
          {{ c.hook }}
        </div>
      </div>
    </div>
  </div>
</template>
