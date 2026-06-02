/**
 * Prompt 注册中心：将所有硬编码 prompt 注册为可查看/可编辑的模板。
 * 应用启动时调用 registerBuiltinPrompts() 完成注册。
 * 运行时通过 resolvePrompt(key) 获取有效 prompt 文本（用户覆盖 > 内置默认）。
 */

import { promptTemplateDAO } from '../db'
import type { PromptCategory, PromptRiskLevel } from '../db'

interface PromptRegistration {
  key: string
  category: PromptCategory
  label: string
  builtinVersion: number
  builtinText: string
  description?: string
  variables?: string[]
  riskLevel?: PromptRiskLevel
}

const BUILTIN_PROMPTS: PromptRegistration[] = [
  // ── 正文生成 ──
  {
    key: 'body_generation.system',
    category: 'body',
    label: '正文生成 · 作者人设',
    builtinVersion: 1,
    builtinText: [
      '你是一个注重细节的严肃的网文作者。根据大纲和上下文写小说正文。',
      '从上一章结尾自然延续，注意回收伏笔。',
      '',
      '【字数与内容密度约束】',
      '- 字数目标是参考范围，不是必须凑满的硬性指标。大纲情节写完即可自然收尾。',
      '- 禁止为凑字数而：重复角色已表达过的心理活动、堆砌无叙事功能的环境描写、添加大纲之外的新情节线、用不同措辞复述同一信息。',
      '- 每个场景/情节点只展开一次，写透即过，不要反复渲染。',
      '- 如果大纲内容在目标范围下限附近已自然写完，直接结束本章，不要硬撑。'
    ].join('\n'),
    description: '正文生成时的 system prompt 开头：定义作者角色和字数密度约束。这是模型收到的第一段指令。',
    riskLevel: 'safe'
  },
  {
    key: 'body_generation.continuity_rule',
    category: 'body',
    label: '正文生成 · 连贯性约束',
    builtinVersion: 1,
    builtinText: [
      '【正文连贯性约束】',
      '1. 须从上一章结尾自然延续，禁止重述已发生事件或重新开场',
      '2. 人物言行须与角色快照、人设卡片一致',
      '3. 用场景与动作展示性格，避免直述「性格XX」「十分美丽」',
      '4. 本章只完成大纲任务，不提前写后续章节内容'
    ].join('\n'),
    description: '约束正文与上一章的衔接规则，防止重述或跑偏。',
    riskLevel: 'safe'
  },
  {
    key: 'body_generation.human_writing_meta',
    category: 'body',
    label: '正文生成 · 人类写作特征',
    builtinVersion: 1,
    builtinText: [
      '【人类写作底层模式 - AI 检测器的核心判据是统计分布，不是某几个词】',
      '人类作者的文字有三个 AI 做不到的统计特征，你必须刻意模拟：',
      '',
      'A. 困惑度波动（Perplexity Burstiness）',
      '   人写的文字里，有些句子极其平淡可预测（"他坐下了。"），紧接着就是意想不到的表达。',
      '   → 做法：每隔 3-5 句就插入一个完全"无聊"的动作句或环境句，然后突然接一个跳跃性的细节。',
      '',
      'B. 信息密度不均匀',
      '   人写的段落里，有的段只说一件事（"他没动。"），有的段塞满了杂乱的细节。',
      '   → 做法：交替使用"高密度段"（一段里塞 3-4 个具体细节）和"低密度段"（一段只一两句话）。',
      '',
      'C. 词汇选择的意外性',
      '   人类会突然用一个"不属于这个语境"的词：品牌名、方言、粗话、数字、跑题的联想。',
      '   → 做法：叙述中每 300 字至少掺入 1 个具体的、意外的、不优美的细节词。',
      '',
      '反面教材：如果你的输出全篇像散文诗——句句优美、段段饱满、节奏均匀——那就是 100% AI 味。',
      '目标：写出来的东西应该像一个赶稿的人类作者在深夜写的——有精彩的段落，也有偷懒的段落，有灵光一闪也有平铺直叙。'
    ].join('\n'),
    description: '当去 AI 味深层规则激活时注入的人类写作统计特征说明。教模型模拟困惑度波动、信息密度不均和词汇意外性。',
    riskLevel: 'safe'
  },

  // ── 稿件优化 ──
  {
    key: 'body_style_rewrite.system',
    category: 'body',
    label: '稿件优化 · 重写指令',
    builtinVersion: 1,
    builtinText: [
      '你是文字风格转换专家。将以下初稿按目标文风重写，消除 AI 生成痕迹。',
      '',
      '重写规则：',
      '1. 保持原文的情节走向、人物对话内容、事件顺序完全不变',
      '2. 用词、句式节奏、信息密度必须与下方「目标文风范文」保持一致',
      '3. 不得添加原文没有的情节，不得删除原文的关键事件和对话',
      '4. 允许且鼓励调整段落划分、句子长短、叙述节奏',
      '5. 像一个赶稿的人类作者，不是力求完美的 AI',
      '6. 若用户指定了目标字数，重写后正文须控制在该字数范围内（允许±10%浮动）',
      '',
      '只输出重写后的正文，不要解释。'
    ].join('\n'),
    description: '稿件优化（二次重写）的 system prompt 基座。模型按此指令将初稿转写为目标文风。',
    riskLevel: 'safe'
  },

  // ── AI 痕迹润色 ──
  {
    key: 'ai_trace_polish.system',
    category: 'body',
    label: 'AI 痕迹润色指令',
    builtinVersion: 1,
    builtinText: [
      '你是文字润色专家，消除以下文本中的 AI 生成痕迹。核心原则：像一个赶稿的人类作者而非一个力求完美的AI。',
      '',
      '具体操作：',
      '1. 减少「然而/因此/总的来说」等连接词堆砌，用具体动作句代替过渡',
      '2. 替换「心中涌起一股/眼中闪过一丝」等模板化情感表达，改用身体细节',
      '3. 大幅削减比喻密度——每500字最多保留1处比喻，其余改为白描',
      '4. 打破句长均匀性——插入碎片短句（3-6字），打断长句连续',
      '5. 添加 2-3 个"白开水"段落——纯说事/纯写环境，不带任何修辞',
      '6. 在叙述中掺入意外的具体细节（数字、品牌名、不优美的琐事）',
      '7. 情感高潮段后加入冷叙述段降温',
      '8. 保持原意和情节不变，只输出润色后的正文'
    ].join('\n'),
    description: 'AI 痕迹检测后一键润色的 system prompt。专门消除连接词、模板句、比喻密度等 AI 特征。',
    riskLevel: 'safe'
  },

  // ── 实验室 ──
  {
    key: 'lab_deai.system',
    category: 'lab',
    label: '去AI实验室 · 基础指令',
    builtinVersion: 1,
    builtinText: '你是一个极其厌恶AI的网文作家。',
    description: '去 AI 实验室重写的基础人设指令。后续会拼接文风模板和去 AI 味规则。',
    riskLevel: 'safe'
  },

  // ── 模型辩论 ──
  {
    key: 'debate_fusion.system',
    category: 'tool',
    label: '模型辩论 · 融合指令',
    builtinVersion: 1,
    builtinText: '对比两个版本，简述差异点，并给出融合建议（各取所长）。200字以内。',
    description: '模型辩论功能中融合两个版本的指令。',
    riskLevel: 'safe'
  }
]

/**
 * 应用启动时调用，将所有内置 prompt 注册到数据库。
 * 幂等操作：已存在且版本相同的不重复写入。
 */
export function registerBuiltinPrompts(): void {
  for (const entry of BUILTIN_PROMPTS) {
    promptTemplateDAO.register(entry)
  }
}

/**
 * 获取有效 prompt 文本（用户覆盖 > 内置默认）。
 * 运行时调用，走内存缓存。
 */
export function resolvePrompt(key: string): string {
  return promptTemplateDAO.resolve(key)
}
