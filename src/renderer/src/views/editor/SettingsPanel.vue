<script setup lang="ts">
import { ref, computed, onMounted, onActivated, inject, watch, nextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import SettingVersionHistory from '../../components/SettingVersionHistory.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import StepNavFooter from './StepNavFooter.vue'
import CharacterCardsPanel from './CharacterCardsPanel.vue'
import SettingsQualityPanel from './SettingsQualityPanel.vue'
import StoryTitleAndHookGenerator from './StoryTitleAndHookGenerator.vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import SectionsPreviewDialog, { type PreviewSection } from '../../components/SectionsPreviewDialog.vue'
import type { NameEntryRow } from '../../../../shared/name-registry-types'
import { GENRE_TREE } from '../../../../shared/genre-worldview-config'
import {
  CORE_SETTING_TYPES,
  CORE_SETTING_LABELS,
  CORE_SETTING_ICONS,
  CORE_SETTING_DESCRIPTIONS,
  CORE_SETTING_DEPENDENCIES,
  CORE_SETTING_FILL_ORDER,
  type CoreSettingType
} from '../../../../shared/settings-types'
import { editorNavKey } from './editor-nav'
import { storyHotWordPromptSection } from '../../../../shared/story-hot-words'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)
const nav = inject(editorNavKey)

const settingTypes = computed(() => {
  if (workType.value === 'story') {
    return [
      {
        type: 'protagonist' as const,
        label: '主角与反差设定',
        icon: 'crown',
        desc: '主角的身份标签、核心欲望、人设反差行为与魅力点'
      },
      {
        type: 'golden_finger' as const,
        label: '核心钩子与信息差',
        icon: 'star',
        desc: '有特殊设定则填金手指；纯情感向则填身份反差与信息差设计'
      },
      {
        type: 'pleasure_engine' as const,
        label: '情绪节奏与爽点',
        icon: 'fire',
        desc: '开篇即冲突、前三章爆发、中点反转与终局极致清算'
      },
      {
        type: 'supporting_cast' as const,
        label: '功能性配角',
        icon: 'users',
        desc: '极品反派、助攻配角、喜剧对照组等，服务于主角情绪爽感'
      }
    ]
  }
  return CORE_SETTING_TYPES.map(type => ({
    type,
    label: CORE_SETTING_LABELS[type],
    icon: CORE_SETTING_ICONS[type],
    desc: CORE_SETTING_DESCRIPTIONS[type]
  }))
})

type SettingType = CoreSettingType
type WorldviewGenreDetectMode = 'strict' | 'balanced' | 'loose'

const aiSystemPrompts: Record<SettingType, string> = {
  protagonist: [
    '你是顶级的角色设计师。基于以下故事信息，深度设计主角。',
    '若上下文含「用户补充要求」，须严格遵守（含角色姓名、性别等）。',
    '核心原则：',
    '- 网文主角最怕「无聊」——主角必须有清晰的标签、强烈的欲望、显著的缺陷',
    '- 好的主角让读者产生「我想看他怎么翻盘/成长/反击」的期待',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 身份标签 / ## 核心欲望 / ## 性格驱动力 / ## 致命缺陷 / ## 决策模式 / ## 不可触碰的底线 / ## 魅力点',
    '- 总字数 500-1000 字',
    '- 身份标签：2-3 个高辨识度标签，如"被家族抛弃的废物嫡子 + 地下黑市情报贩子"',
    '- 核心欲望：一句话说清他到底想要什么',
    '- 性格驱动力：什么情绪/信念驱使他行动（复仇/守护/证明/好奇/恐惧）',
    '- 致命缺陷：直接导致至少一次重大危机的性格弱点',
    '- 决策模式：面对压力时的默认反应（硬刚/迂回/隐忍/逃跑），用「当 X → 他会 Y」格式',
    '- 底线：一旦触碰就不惜代价反击的原则',
    '- 魅力点：读者为什么喜欢他？需要具体，不能是"很帅/很强"',
    '- 禁止写叙事段落或场景示例'
  ].join('\n'),
  golden_finger: [
    '你是顶级的能力系统设计师。基于以下主角设定和故事信息，设计金手指系统。',
    '若上下文含「用户补充要求」，须严格遵守。',
    '核心原则：',
    '- 限制比能力更重要——金手指应同时是优势来源和麻烦来源',
    '- 好的金手指让读者理解「主角凭什么赢」和「主角为什么还不能赢」',
    '- 金手指决定了整本书的核心玩法，不是装饰性设定',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 名称与形态 / ## 核心能力 / ## 获取方式与觉醒条件 / ## 限制条件 / ## 反噬机制 / ## 升级路径 / ## 信息差优势',
    '- 总字数 400-800 字',
    '- 核心能力最多 3 个，宁可少而精——能力越多=越无聊',
    '- 限制条件要具体到数值或场景（冷却多久/消耗什么/什么情况下失效）',
    '- 反噬机制是冲突的自然来源，不能是"用多了会累"这种无效限制',
    '- 升级路径写明能力如何成长（等级/解锁新功能/融合进化）',
    '- 信息差优势：主角知道什么别人不知道的？这是智斗和反转的基础',
    '- 禁止写"无敌""全能"类设计'
  ].join('\n'),
  pleasure_engine: [
    '你是顶级的网文节奏与爽点设计大师。基于以下设定信息，设计全书的爽点机制。',
    '若上下文含「用户补充要求」，须严格遵守。',
    '核心原则：',
    '- 爽点不是"隔几章来一个高潮"——爽点是读者持续追读的理由',
    '- 不同类型的爽点需要不同的对抗设计来反衬',
    '- 爽点频率必须和金手指的冷却/升级节奏对齐',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 主要爽点类型 / ## 触发条件与场景 / ## 频率设计 / ## 对抗设计 / ## 情绪节奏锚点',
    '- 总字数 300-600 字',
    '- 主要爽点类型选 1-2 个：打脸/升级/智斗/情感/探索/碾压，说明为什么选这个',
    '- 触发条件具体到场景：什么事件、什么对手、什么时机',
    '- 频率设计：小爽点间隔几章？大爽点间隔几章？与金手指冷却如何咬合？',
    '- 对抗设计：爽点需要「不够爽」来反衬——谁被打脸？什么阻碍了成长？',
    '- 情绪节奏锚点：读者从期待→紧张→爆发→满足→新期待的完整循环'
  ].join('\n'),
  world_pressure: [
    '你是顶级的世界观架构师。基于以下故事和设定信息，设计世界观的压力规则系统。',
    '若上下文含「用户补充要求」，须严格遵守。',
    '若上下文含「题材世界观检查项」，必须逐条覆盖，尤其是「必须覆盖（阻断项）」。',
    '核心原则：',
    '- 网文世界观不是百科全书——只写「会对角色选择产生压力的规则」',
    '- 如果一条规则不会逼迫任何角色做出困难选择，就不值得写',
    '- 世界观是冲突的土壤，不是装饰性的背景板',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 核心铁律 / ## 权力与阶级结构 / ## 资源稀缺性 / ## 规则代价 / ## 规则漏洞 / ## 压迫升级路径',
    '- 总字数 600-1500 字',
    '- 核心铁律不超过 3 条，每条用一两句话说清：是什么、为什么、违反会怎样',
    '- 权力结构：谁在上谁在下、为什么、阶级间能否流动',
    '- 资源稀缺性：争的到底是什么（灵石/功法/信息/名额/时间/寿命）、为什么稀缺',
    '- 规则代价：利用规则要承受什么反噬——这是冲突的自然引擎',
    '- 规则漏洞：主角凭什么找到突破口——必须逻辑自洽，不能是"主角光环"',
    '- 压迫升级路径：规则如何逐阶段对主角施加更大压力——3 个阶段的递增',
    '- 禁止百科词条式的冗长描述，禁止"天地初开"式的创世神话'
  ].join('\n'),
  conflict_engine: [
    '你是顶级的冲突架构师。基于以下设定信息，设计全书的冲突升级引擎。',
    '若上下文含「用户补充要求」或「核心冲突结构检查项」，须严格遵守。',
    '核心原则：',
    '- 冲突不是"谁跟谁打架"——冲突是价值观的对立 + 不可调和的赌注 + 逐级升级的机制',
    '- 好的冲突引擎让读者每一章都想知道「接下来怎么办」',
    '- 冲突的升级必须绑定到具体角色的选择，而非抽象设定',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 对立双方 / ## 不可调和点 / ## 三层赌注 / ## 升级机制 / ## 冲突反转点 / ## 终局收束',
    '- 总字数 500-1200 字',
    '- 对立双方用价值观层面描述：不是"主角 vs 反派"，是"XX价值观 vs XX价值观"',
    '- 不可调和点：双方的底线为何无法共存——必须具体到行为层面',
    '- 三层赌注：个人层面（主角会失去什么）/ 关系层面（谁会受牵连）/ 世界层面（世界会变成什么样）',
    '- 升级机制：冲突如何从个人→家族→势力→世界→规则本身，每层升级标注触发事件',
    '- 冲突反转点：至少 2 次读者预判之外的冲突转向',
    '- 终局收束：冲突的最终解决如何呼应主角的致命缺陷和金手指的反噬机制'
  ].join('\n'),
  supporting_cast: [
    '你是顶级的配角设计师。基于以下主角设计和冲突信息，设计配角功能组。',
    '若上下文含「用户补充要求」，须严格遵守。',
    '若上下文含「已有结构化人设卡片」，须与已有卡片保持一致。',
    '核心原则：',
    '- 配角不是"另一个角色"——配角是主角故事的功能组件',
    '- 配角标准：记忆点 > 完整性——不需要和主角一样丰满，但必须有辨识度',
    '- 每个配角应有明确的功能定位，避免功能重复',
    '输出要求：',
    '- 用 Markdown 输出，按六种功能分组：## 催化剂型 / ## 对照组型 / ## 阻力型 / ## 情感锚型 / ## 信息型 / ## 喜剧型',
    '- 如果没有某类功能的配角，标注「（暂无）」即可',
    '- 每个配角 200-400 字',
    '- 催化剂型：推动主角行动/觉醒/改变的角色',
    '- 对照组型：和主角做不同选择，映衬主角选择的意义',
    '- 阻力型：制造障碍（不一定是反派——也可以是关心主角但方式错误的人）',
    '- 情感锚型：主角的情感支撑，读者的情感投射对象',
    '- 信息型：掌握关键信息，驱动解密线',
    '- 喜剧型：调节节奏，防止读者疲劳',
    '- 每个配角标注：功能标签 + 与主角的关系动力学（非静态关系，而是关系的演变方向）',
    '- 禁止写长篇背景故事，配角只需「读者能记住的一个特征 + 对主角的一个作用」'
  ].join('\n')
}

const STORY_HOT_WORD_PROMPT = storyHotWordPromptSection()

const aiSystemPromptsStory: Record<SettingType, string> = {
  protagonist: [
    '你是顶级的短故事人设设计师。请为以下短故事大纲设计具有极强吸引力的主角人设。',
    '短故事角色不需要复杂的成长弧光，必须在开篇就通过强烈的标签与反差立住。',
    '核心原则：构建“人设反差矩阵”',
    '- 基础设定与极致反差行为：例如“看似卑微的保洁阿姨 x 顶级财阀掌控者”，“摆烂真千金 x 京圈毒舌掌权人”',
    '- 极致情绪驱动：主角必须有极强的执念或痛点（如复仇、逆袭、反向打脸、夺回尊严）',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 身份与反差标签 / ## 核心痛点与执念 / ## 反差行为矩阵 / ## 爽点爆发时机 / ## 主角金句与对抗姿态',
    '- 总字数 400-800 字',
    '- 身份与反差标签：精炼成一句话，如“被送去和亲的摆烂公主 x 口嫌体正直的敌国暴君”',
    '- 核心痛点与执念：他/她最想撕碎的憋屈或誓要达成的目标是什么',
    '- 反差行为矩阵：平常状态 vs 爆发/面对冲突时的极致反差表现',
    '- 爽点爆发时机：第一章如何亮出态度？第三章如何小反转？',
    '- 主角金句：能够瞬间击中读者、表现主角态度的一两句经典台词',
    '- 禁止任何叙事段落。',
    STORY_HOT_WORD_PROMPT
  ].join('\n'),
  golden_finger: [
    '你是顶级的短故事核心钩子设计师。请先判断以下故事是否包含特殊设定机制，再选择对应路径输出。',
    '',
    '【路径 A：有特殊设定/金手指机制的故事】',
    '若故事存在超自然/特殊信息差设定，输出：',
    '## 设定名称与形态 / ## 核心展现机制（如何融入日常冲突） / ## 信息差构建（主角知道什么/别人不知道什么） / ## 限制与紧迫感（避免万能导致失去张力） / ## 对核心冲突的推动作用',
    '',
    '【路径 B：纯情感/现实向故事（无金手指）】',
    '若故事无特殊设定机制，改为设计「身份反差与信息差」，输出：',
    '## 身份反差设计（主角表面身份 vs 隐藏实力/背景） / ## 关键信息差（读者先知哪些、主角后知哪些、反派不知哪些） / ## 信息差释放节奏（何时揭晓、如何制造爽点） / ## 反差爆发场景（最能体现反差的1-2个关键场景设计）',
    '',
    '【通用要求】',
    '- 总字数 350-700 字',
    '- 必须说明该设计如何直接服务于主角的爽点爆发',
    '- 禁止万能设定，限制条件是制造张力的核心工具',
    STORY_HOT_WORD_PROMPT
  ].join('\n'),
  pleasure_engine: [
    '你是顶级的短故事节奏与情绪设计大师。短故事完读率极度依赖“憋屈→清醒→反击→极致清算”的情绪曲线。',
    '核心原则：',
    '- 拒绝拖泥带水，情绪爽感要极速清算。',
    '- 黄金开局（前1-3节拍）必须有第一波爽感/反转，中段必须有二次情绪波峰。',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 开篇憋屈/危机点（前300字） / ## 黄金开局爽感/反击（黄金留存区） / ## 中点反转（情绪爆发点） / ## 终局极致爽感清算（爽点落地）',
    '- 总字数 300-600 字',
    '- 开篇憋屈点：要接地气、引发强烈共鸣（被网暴、被迫替嫁、被极品房东驱逐）',
    '- 黄金开局反击：主角在此立下鲜明人设，展开第一波反击，产生小高潮',
    '- 中点反转：剧情突变（如情夫身份揭晓、重生底牌脑洞引流），将情绪拉到最满',
    '- 终局清算：给反派最彻底的善恶有报，让读者情绪彻底宣泄',
    STORY_HOT_WORD_PROMPT
  ].join('\n'),
  supporting_cast: [
    '你是顶级的短故事配角设计师。基于主角设定和主线信息，设计功能性配角。',
    '核心原则：',
    '- 配角是主角故事的工具人，不需要深度的背景，但必须有极高的辨识度。',
    '- 必须包含一个负责拉满读者仇恨的极品角色（如自私小姑子、偏心婆婆、绿茶妹妹），和一个给主角助攻的对照组或支持者。',
    '输出要求：',
    '- 用 Markdown 结构化输出：## 核心极品/反派角色 / ## 关键支持者/对照组 / ## 喜剧/信息传递功能工具人 / ## 关系演变与情绪宣泄点',
    '- 总字数 350-700 字',
    '- 核心极品角色：写明其极品行为、人性弱点，以及如何引发读者的“憋屈感”',
    '- 关键支持者/对照组：如何通过和主角的互动衬托主角的睿智或反差',
    STORY_HOT_WORD_PROMPT
  ].join('\n'),
  world_pressure: '',
  conflict_engine: ''
}

const coreSettings = ref<{ type: string; content: string }[]>([])
const editingType = ref<SettingType | null>(null)
const draftByType = ref<Partial<Record<SettingType, string>>>({})
const aiLoadingByType = ref<Partial<Record<SettingType, boolean>>>({})
const aiErrorByType = ref<Partial<Record<SettingType, string>>>({})
const lastAiContext = ref('')
const worldviewGenreOverride = ref('')
const worldviewGenreDetectMode = ref<WorldviewGenreDetectMode>('balanced')
const worldviewGenreMeta = ref<{
  inferredGenreId: string | null
  inferredGenreLabel: string
  resolvedGenreId: string
  resolvedGenreLabel: string
  overridden: boolean
  source: 'keyword' | 'ai_fallback'
} | null>(null)
const worldviewGenreOptions = GENRE_TREE.map(g => ({ id: g.id, label: g.label }))
const worldviewDetectModeOptions: { value: WorldviewGenreDetectMode; label: string; hint: string }[] = [
  { value: 'strict', label: '严格', hint: '更容易触发 AI 兜底，减少误判' },
  { value: 'balanced', label: '平衡', hint: '关键词与稳定性折中（推荐）' },
  { value: 'loose', label: '宽松', hint: '更相信关键词结果，减少额外判别' }
]

const GEN_HINTS_META: Record<SettingType, {
  title: string
  desc: string
  placeholder: string
  showNamePicker: boolean
}> = {
  protagonist: {
    title: '主角设计',
    desc: '可填写本次生成的补充要求（如姓名、性别、身份背景）。留空则仅依据故事方向与大岗主线生成。',
    placeholder: '例如：主角名沈辙，28岁退役特种兵；不要伟光正人设；缺陷偏执型人格…',
    showNamePicker: true
  },
  golden_finger: {
    title: '金手指系统',
    desc: '可指定金手指的方向与约束（如系统类型、能力范围、禁忌）。留空则依据主角设计自动推导。',
    placeholder: '例如：签到流系统，但不能太无敌；反噬机制要真实伤害级别；升级节奏偏慢…',
    showNamePicker: false
  },  pleasure_engine: {
    title: '爽点机制',
    desc: '可指定本书的核心爽点方向与节奏偏好。留空则依据金手指和冲突自动推导。',
    placeholder: '例如：主打智斗碾压爽；每10章一个打脸高潮；不要纯升级爽…',
    showNamePicker: false
  },
  world_pressure: {
    title: '世界观压力规则',
    desc: '可填写补充要求（如时代背景、力量体系侧重、题材指定）。留空则依据故事方向和已有设定生成。',
    placeholder: '例如：现代都市低魔；禁止时间穿越；力量体系以情绪共鸣为核心…',
    showNamePicker: false
  },
  conflict_engine: {
    title: '冲突升级引擎',
    desc: '可指定冲突方向与升级节奏偏好。留空则依据主角、世界观和已有设定生成。',
    placeholder: '例如：主线聚焦家族继承权；副线加入青梅重逢；第三幕需公开身份反转…',
    showNamePicker: false
  },
  supporting_cast: {
    title: '配角功能组',
    desc: '可指定配角方向（如关键配角姓名、关系、功能类型）。留空则依据主角设计和冲突引擎自动推导。',
    placeholder: '例如：需要一个对照组发小；反派需有悲剧内核；加入喜剧担当的师弟…',
    showNamePicker: true
  }
}

/** AI 生成弹窗中的用户补充（按作品与类型持久化，不写入设定正文） */
const hintsDialogType = ref<SettingType | null>(null)
const genHints = ref('')
const namePickerOpen = ref(false)
const hintsInputRef = ref<HTMLTextAreaElement | null>(null)

const hintsDialogMeta = computed(() => {
  if (!hintsDialogType.value) return null
  const base = GEN_HINTS_META[hintsDialogType.value]
  if (workType.value === 'story' && hintsDialogType.value === 'golden_finger') {
    return {
      ...base,
      title: '核心钩子与信息差',
      desc: '有特殊设定填金手指方向；无特殊设定则描述身份反差或关键信息差设计。留空则 AI 自动判断并选择路径。',
      placeholder: '例如：纯现实向，主角是假千金真大佬，信息差靠身份反差；'
    }
  }
  return base
})
const expandedTypes = ref<Set<SettingType>>(new Set())
const versionHistoryRefs = ref<Partial<Record<SettingType, { load: () => Promise<void> }>>>({})
const characterCardsRef = ref<{ expandPanel?: () => void; load?: () => Promise<void> } | null>(null)
const qualityPanelRef = ref<{ load?: () => Promise<void> } | null>(null)

const workType = ref<string | null>(null)

const editingMeta = computed(() =>
  settingTypes.value.find(st => st.type === editingType.value) ?? null
)

const hasAnyCoreSetting = computed(() =>
  settingTypes.value.some(st => getSetting(st.type).trim())
)

const previewOpen = ref(false)
const previewSections = ref<PreviewSection[]>([])

function openSettingsPreview() {
  const sections: PreviewSection[] = []
  for (const st of settingTypes.value) {
    const content = getSetting(st.type).trim()
    if (content) sections.push({ label: st.label, content })
  }
  previewSections.value = sections
  previewOpen.value = true
}

async function loadCoreSettings() {
  coreSettings.value = await window.anovel.invoke('setting:listByWork', props.workId) as never[]
}

async function reloadPanelData() {
  const w = await window.anovel.invoke('work:get', props.workId)
  workType.value = (w as { work_type?: string })?.work_type ?? null
  await loadCoreSettings()
  await characterCardsRef.value?.load?.()
  await qualityPanelRef.value?.load?.()
}

onMounted(() => void reloadPanelData())
onActivated(() => void reloadPanelData())

watch(
  () => props.workId,
  () => {
    genHints.value = ''
    hintsDialogType.value = null
    void reloadPanelData()
  }
)

function bindVersionRef(type: SettingType, el: Element | ComponentPublicInstance | null) {
  if (el && typeof el === 'object' && 'load' in el) {
    versionHistoryRefs.value[type] = el as { load: () => Promise<void> }
  }
}

async function refreshVersionHistory(type: SettingType) {
  await versionHistoryRefs.value[type]?.load?.()
}

async function onSettingVersionRestored(type: SettingType) {
  await loadCoreSettings()
  await nav?.refreshProgress()
  await refreshVersionHistory(type)
}

function getSetting(type: string) {
  return coreSettings.value.find(s => s.type === type)?.content || ''
}

function isExpanded(type: SettingType) {
  return expandedTypes.value.has(type)
}

function toggleExpand(type: SettingType) {
  if (editingType.value === type) return
  const next = new Set(expandedTypes.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  expandedTypes.value = next
}

function contentSummary(type: SettingType): string {
  const text = getSetting(type)
  if (!text) return ''
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? ''
  const plain = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  const charCount = text.replace(/\s/g, '').length
  if (plain) {
    return plain.length > 48 ? `${plain.slice(0, 48)}… · ${charCount} 字` : `${plain} · ${charCount} 字`
  }
  return `已设定 · ${charCount} 字`
}

function getDraft(type: SettingType) {
  return draftByType.value[type] ?? ''
}

function setDraft(type: SettingType, value: string) {
  draftByType.value = { ...draftByType.value, [type]: value }
}

function onDraftInput(e: Event) {
  if (!editingType.value) return
  setDraft(editingType.value, (e.target as HTMLTextAreaElement).value)
}

function normalizeWorldviewDetectMode(
  mode: string | null | undefined
): WorldviewGenreDetectMode {
  if (mode === 'strict' || mode === 'balanced' || mode === 'loose') return mode
  return 'balanced'
}

interface SettingsGenerationContextIpcResult {
  text: string
  meta?: {
    worldviewGenre?: {
      inferredGenreId: string | null
      inferredGenreLabel: string
      resolvedGenreId: string
      resolvedGenreLabel: string
      overridden: boolean
      source: 'keyword' | 'ai_fallback'
    }
  }
}

async function getStoryContext(
  type: SettingType,
  userHints?: string,
  genreIdOverride?: string,
  genreDetectMode?: WorldviewGenreDetectMode
): Promise<SettingsGenerationContextIpcResult> {
  const draft = getDraft(type).trim() || getSetting(type).trim()
  const hints = userHints?.trim() ?? ''
  const options: {
    selfDraft?: string
    userHints?: string
    genreIdOverride?: string
    genreDetectMode?: WorldviewGenreDetectMode
  } = {}
  if (draft) options.selfDraft = draft
  if (hints) options.userHints = hints
  if (type === 'world_pressure') {
    if (genreIdOverride?.trim()) options.genreIdOverride = genreIdOverride.trim()
    options.genreDetectMode = genreDetectMode ?? worldviewGenreDetectMode.value
  }
  const ctx = await window.anovel.invoke(
    'context:buildSettingsGeneration',
    props.workId,
    type,
    Object.keys(options).length ? options : undefined
  ) as SettingsGenerationContextIpcResult
  if (ctx.text) return ctx
  return { text: ideaInputFallback() }
}

function ideaInputFallback(): string {
  return getSetting('idea') || '（尚未填写故事方向，请先在孵化器中输入想法）'
}

function startEditSetting(type: SettingType, content?: string) {
  editingType.value = type
  setDraft(type, content ?? getSetting(type))
}

function cancelEdit() {
  editingType.value = null
}

async function saveSetting() {
  const type = editingType.value
  if (!type) return
  const content = getDraft(type).trim()
  await window.anovel.invoke('setting:upsert', props.workId, type, content)
  cancelEdit()
  await loadCoreSettings()
  await refreshVersionHistory(type)
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}

interface ModelChatIpcResult {
  success: boolean
  content: string
  error?: string
}

function onAiSuggestClick(type: SettingType) {
  if (aiLoadingByType.value[type]) return
  void openHintsDialog(type)
}

async function openHintsDialog(type: SettingType) {
  hintsDialogType.value = type
  genHints.value = (await window.anovel.invoke(
    'setting:getGenHints',
    props.workId,
    type
  )) as string
  if (type === 'world_pressure') {
    worldviewGenreOverride.value = ''
    worldviewGenreMeta.value = null
    const savedMode = (await window.anovel.invoke(
      'setting:getWorldviewGenreDetectMode',
      props.workId
    )) as string | null
    worldviewGenreDetectMode.value = normalizeWorldviewDetectMode(savedMode)
  }
  await nextTick()
  hintsInputRef.value?.focus()
  if (type === 'world_pressure') {
    await refreshWorldviewGenrePreview()
  }
}

function closeHintsDialog() {
  hintsDialogType.value = null
  worldviewGenreOverride.value = ''
  worldviewGenreMeta.value = null
  worldviewGenreDetectMode.value = 'balanced'
}

function insertNameHint(entry: NameEntryRow) {
  const snippet = entry.meaning?.trim() ? `${entry.name}（${entry.meaning.trim()}）` : entry.name
  const prefix = genHints.value.trim()
  genHints.value = prefix ? `${prefix}；${snippet}` : `角色名：${snippet}`
  void nextTick(() => hintsInputRef.value?.focus())
}

async function confirmAiSuggest() {
  const type = hintsDialogType.value
  if (!type) return
  const hints = genHints.value.trim()
  const genreOverride = type === 'world_pressure' ? worldviewGenreOverride.value : undefined
  const detectMode = type === 'world_pressure' ? worldviewGenreDetectMode.value : undefined
  await window.anovel.invoke('setting:setGenHints', props.workId, type, hints)
  if (type === 'world_pressure') {
    await window.anovel.invoke('setting:setWorldviewGenreDetectMode', props.workId, detectMode)
  }
  closeHintsDialog()
  await runAiSuggest(type, hints, genreOverride, detectMode)
}

async function refreshWorldviewGenrePreview() {
  if (hintsDialogType.value !== 'world_pressure') return
  const ctx = await getStoryContext(
    'world_pressure',
    genHints.value,
    worldviewGenreOverride.value,
    worldviewGenreDetectMode.value
  )
  worldviewGenreMeta.value = ctx.meta?.worldviewGenre ?? null
}

async function runAiSuggest(
  type: SettingType,
  userHints?: string,
  genreIdOverride?: string,
  genreDetectMode?: WorldviewGenreDetectMode
) {
  if (aiLoadingByType.value[type]) return

  aiLoadingByType.value = { ...aiLoadingByType.value, [type]: true }
  aiErrorByType.value = { ...aiErrorByType.value, [type]: '' }

  try {
    const ctx = await getStoryContext(type, userHints, genreIdOverride, genreDetectMode)
    const context = ctx.text
    lastAiContext.value = context
    if (type === 'world_pressure') {
      worldviewGenreMeta.value = ctx.meta?.worldviewGenre ?? null
    }

    const res = await window.anovel.invoke('model:chat', {
      prompt: context,
      systemPrompt: workType.value === 'story' ? aiSystemPromptsStory[type] : aiSystemPrompts[type],
      workId: props.workId,
      step: `settings_${type}`,
      enrichWorkContext: false,
      ...bodyModelParams()
    }) as ModelChatIpcResult

    if (res.success) {
      setDraft(type, res.content)
      editingType.value = type
    } else {
      aiErrorByType.value = { ...aiErrorByType.value, [type]: res.error || '生成失败' }
    }
  } catch (e) {
    aiErrorByType.value = { ...aiErrorByType.value, [type]: String(e) }
  } finally {
    const nextLoading = { ...aiLoadingByType.value }
    delete nextLoading[type]
    aiLoadingByType.value = nextLoading
  }
}

function openAnchors() {
  nav?.goToPanel?.('anchors')
}

async function onSettingContentChanged() {
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}

async function onQualityRefreshed() {
  await loadCoreSettings()
  await characterCardsRef.value?.load?.()
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}

async function clearAllSettings() {
  if (!confirm('确定要清空所有核心设定内容吗？此操作不可撤销。')) return
  for (const st of settingTypes.value) {
    await window.anovel.invoke('setting:upsert', props.workId, st.type, '')
  }
  await loadCoreSettings()
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="sliders" title="核心设定" />
    <div class="flex items-start justify-between gap-4 mb-6">
      <p class="text-sm text-base-content/50 min-w-0">
        <template v-if="workType === 'story'">
          短故事核心设定。推荐填写顺序：主角与反差设定 → 核心钩子与信息差 → 情绪节奏与爽点 → 功能性配角 → 结构化人设卡片 → 爆款书名与导语。AI 生成会自动带入已填的依赖设定。
        </template>
        <template v-else>
          六类核心设定构成网文的故事引擎。推荐按依赖顺序填充：主角 → 金手指 → 世界观压力 → 冲突引擎 → 爽点机制 → 配角功能组。AI 生成会自动带入已填的依赖设定。
        </template>
      </p>
      <div class="flex gap-2 shrink-0">
        <button
          type="button"
          class="btn btn-outline btn-primary btn-sm gap-1.5"
          :disabled="!hasAnyCoreSetting"
          @click="openSettingsPreview"
        >
          <font-awesome-icon icon="eye" class="w-3.5 h-3.5" />
          预览全部设定
        </button>
        <button
          type="button"
          class="btn btn-outline btn-error btn-sm gap-1.5"
          :disabled="!hasAnyCoreSetting"
          @click="clearAllSettings"
        >
          <font-awesome-icon icon="trash-can" class="w-3.5 h-3.5" />
          清空所有内容
        </button>
      </div>
    </div>

    <div class="space-y-4">
      <div v-for="st in settingTypes" :key="st.type" class="card bg-base-200 border border-base-300 shadow-sm p-4">
        <div class="flex items-start justify-between mb-2">
          <div>
            <h4 class="font-semibold flex items-center gap-2">
              <font-awesome-icon :icon="st.icon" class="w-3.5 h-3.5 text-primary shrink-0" />
              {{ st.label }}
            </h4>
            <p class="text-xs text-base-content/40 mt-0.5">{{ st.desc }}</p>
          </div>
          <div class="flex gap-2">
            <button
              class="btn btn-primary btn-xs gap-1"
              :disabled="!!aiLoadingByType[st.type]"
              @click="onAiSuggestClick(st.type)"
            >
              <font-awesome-icon
                :icon="aiLoadingByType[st.type] ? 'spinner' : 'robot'"
                :spin="!!aiLoadingByType[st.type]"
                class="w-3 h-3"
              />
              {{ aiLoadingByType[st.type] ? '生成中...' : 'AI 生成建议' }}
            </button>
            <button
              class="btn btn-outline btn-primary btn-xs gap-1"
              @click="startEditSetting(st.type)"
            >
              <font-awesome-icon :icon="getSetting(st.type) ? 'edit' : 'plus'" class="w-3 h-3" />
              {{ getSetting(st.type) ? '编辑' : '添加' }}
            </button>
          </div>
        </div>

        <div v-if="aiErrorByType[st.type]" class="alert alert-error text-xs py-2 mb-3">
          {{ aiErrorByType[st.type] }}
        </div>

        <div v-if="getSetting(st.type)" class="mt-1">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-100/80 transition-colors"
            @click="toggleExpand(st.type)"
          >
            <span class="text-xs text-base-content/60 truncate">{{ contentSummary(st.type) }}</span>
            <font-awesome-icon
              :icon="isExpanded(st.type) ? 'chevron-up' : 'chevron-down'"
              class="w-3 h-3 shrink-0 text-base-content/40"
            />
          </button>
          <div v-show="isExpanded(st.type)" class="mt-2 pt-2 border-t border-base-300/50">
            <MarkdownContent :content="getSetting(st.type)" size="sm" />
          </div>
        </div>
        <p v-else class="text-sm text-base-content/40 italic">尚未设定</p>

        <SettingVersionHistory
          :ref="(el) => bindVersionRef(st.type, el)"
          :work-id="workId"
          :type="st.type"
          @restored="onSettingVersionRestored(st.type)"
        />
      </div>

      <CharacterCardsPanel ref="characterCardsRef" :work-id="workId" :protagonist-only="workType === 'story'" @content-changed="onSettingContentChanged" />
    </div>

    <StoryTitleAndHookGenerator
      v-if="workType === 'story'"
      class="mt-4"
      :work-id="workId"
      @changed="onSettingContentChanged"
    />

    <SettingsQualityPanel
      v-if="hasAnyCoreSetting"
      ref="qualityPanelRef"
      :work-id="workId"
      @open-anchors="openAnchors"
      @refreshed="onQualityRefreshed"
    />

    <StepNavFooter step="settings" :work-id="workId" />

    <dialog :class="['modal', { 'modal-open': hintsDialogType !== null && !!hintsDialogMeta }]">
      <div v-if="hintsDialogMeta && hintsDialogType" class="modal-box max-w-lg">
        <h3 class="font-bold text-lg mb-1">{{ hintsDialogMeta.title }} · AI 生成</h3>
        <p class="text-sm text-base-content/50 mb-4">{{ hintsDialogMeta.desc }}</p>
        <div v-if="hintsDialogType === 'world_pressure'" class="mb-3 space-y-2">
          <div class="flex items-end gap-2">
            <label class="form-control flex-1">
              <span class="label-text text-xs text-base-content/60">题材（可覆盖自动识别）</span>
              <select
                v-model="worldviewGenreOverride"
                class="select select-bordered select-sm w-full"
                @change="refreshWorldviewGenrePreview"
              >
                <option value="">自动识别</option>
                <option v-for="g in worldviewGenreOptions" :key="g.id" :value="g.id">{{ g.label }}</option>
              </select>
            </label>
            <button type="button" class="btn btn-ghost btn-sm" @click="refreshWorldviewGenrePreview">
              刷新识别
            </button>
          </div>
          <label class="form-control">
            <span class="label-text text-xs text-base-content/60">自动识别灵敏度</span>
            <select
              v-model="worldviewGenreDetectMode"
              class="select select-bordered select-sm w-full"
              @change="refreshWorldviewGenrePreview"
            >
              <option v-for="m in worldviewDetectModeOptions" :key="m.value" :value="m.value">
                {{ m.label }}：{{ m.hint }}
              </option>
            </select>
          </label>
          <p v-if="worldviewGenreMeta" class="text-xs text-base-content/55">
            自动识别：{{ worldviewGenreMeta.inferredGenreLabel }} · 当前应用：{{ worldviewGenreMeta.resolvedGenreLabel }}
            <span v-if="worldviewGenreMeta.overridden" class="text-primary">（手动覆盖）</span>
            <span v-else-if="worldviewGenreMeta.source === 'ai_fallback'" class="text-warning">（AI 兜底判别）</span>
          </p>
        </div>
        <div v-if="hintsDialogMeta.showNamePicker" class="flex justify-end mb-2">
          <button type="button" class="btn btn-outline btn-primary btn-xs" @click="namePickerOpen = true">
            从名称库插入
          </button>
        </div>
        <textarea
          ref="hintsInputRef"
          v-model="genHints"
          rows="4"
          class="textarea textarea-bordered w-full text-sm leading-relaxed"
          :placeholder="hintsDialogMeta.placeholder"
          @keydown.ctrl.enter.prevent="confirmAiSuggest"
          @keydown.meta.enter.prevent="confirmAiSuggest"
        />
        <p class="text-xs text-base-content/40 mt-2">
          补充说明会注入 prompt，并记住以便下次生成；不会直接写入{{ hintsDialogMeta.title }}正文。⌘/Ctrl + Enter 开始生成。
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" @click="closeHintsDialog">取消</button>
          <button
            type="button"
            class="btn btn-primary gap-1"
            :disabled="!!aiLoadingByType[hintsDialogType]"
            @click="confirmAiSuggest"
          >
            <font-awesome-icon
              v-if="aiLoadingByType[hintsDialogType]"
              icon="spinner"
              spin
              class="w-3.5 h-3.5"
            />
            {{ aiLoadingByType[hintsDialogType] ? '生成中...' : '开始生成' }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="closeHintsDialog">
        <button type="button">close</button>
      </form>
    </dialog>

    <NamePickerDialog
      :work-id="workId"
      :open="namePickerOpen"
      category="character"
      title="插入角色名到补充说明"
      @close="namePickerOpen = false"
      @select="insertNameHint"
    />

    <dialog :class="['modal', { 'modal-open': editingType !== null }]">
      <div v-if="editingMeta && editingType" class="modal-box w-[92vw] max-w-6xl h-[88vh] p-0 flex flex-col">
        <div class="flex items-center justify-between gap-4 px-6 py-4 border-b border-base-300 shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            <font-awesome-icon :icon="editingMeta.icon" class="w-4 h-4 text-primary shrink-0" />
            <h3 class="font-bold text-lg truncate">编辑 · {{ editingMeta.label }}</h3>
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              type="button"
              class="btn btn-primary btn-sm gap-1"
              @click="saveSetting"
            >
              <font-awesome-icon icon="save" class="w-3 h-3" />
              {{ getDraft(editingType).trim() ? '保存' : '清空并保存' }}
            </button>
            <FavoriteButton
              v-if="getDraft(editingType).trim()"
              :work-id="workId"
              :source-step="`settings_${editingType}`"
              :source-label="`${editingMeta.label}建议`"
              :content="getDraft(editingType)"
              :source-input="lastAiContext"
              size="sm"
            />
            <button type="button" class="btn btn-outline btn-neutral btn-sm gap-1" @click="cancelEdit">
              <font-awesome-icon icon="times" class="w-3 h-3" />
              取消
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0 px-6 py-4 overflow-hidden">
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-base-content/50 mb-2">编辑</p>
            <textarea
              :value="getDraft(editingType)"
              class="textarea textarea-bordered w-full flex-1 min-h-0 resize-none text-sm leading-relaxed"
              :placeholder="`输入${editingMeta.label}...`"
              @input="onDraftInput"
            />
          </div>
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-base-content/50 mb-2">Markdown 预览</p>
            <div class="rounded-lg border border-base-300/60 p-4 bg-base-100 flex-1 min-h-0 overflow-auto">
              <MarkdownContent v-if="getDraft(editingType).trim()" :content="getDraft(editingType)" size="sm" />
              <p v-else class="text-sm text-base-content/40 italic">输入内容后在此实时预览</p>
            </div>
          </div>
        </div>

        <div v-if="getDraft(editingType).trim()" class="px-6 py-4 border-t border-base-300 shrink-0 overflow-auto max-h-48">
          <AiInterventionBar
            :work-id="workId"
            :step="`settings_${editingType}`"
            :content="getDraft(editingType)"
            :regenerate-prompt="lastAiContext || ideaInputFallback()"
            :regenerate-system-prompt="workType === 'story' ? aiSystemPromptsStory[editingType] : aiSystemPrompts[editingType]"
            @update:content="setDraft(editingType, $event)"
          />
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="cancelEdit">
        <button type="button">close</button>
      </form>
    </dialog>

    <SectionsPreviewDialog
      :open="previewOpen"
      title="核心设定预览"
      :sections="previewSections"
      empty-hint="尚未填写任何核心设定"
      @close="previewOpen = false"
    />
  </div>
</template>
