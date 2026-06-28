export const STORY_HOT_WORD_GROUPS = [
  { label: '数字钩子', words: ['三天下跪', '二十万彩礼', '五年隐忍', '百亿身家'] },
  { label: '情绪词', words: ['悔断肠', '当场撕破', '跪求原谅', '绝不回头', '发疯反击'] },
  { label: '人设词', words: ['清醒女主', '疯批大佬', '天才萌宝', '恶毒假千金', '无恋爱脑'] },
  { label: '剧情词', words: ['马甲掉落', '重生归来', '当众揭穿', '和离改嫁', '空间囤货'] }
] as const

export const STORY_HOT_WORDS = STORY_HOT_WORD_GROUPS.flatMap(group => group.words)

export function storyHotWordPromptSection(): string {
  return [
    '【短篇通用爆款热词命名规则】',
    '生成核心设定、爆款书名与导语时，必须优先参考以下热词建立标题钩子、人设标签、情绪爆点和剧情卖点；可直接套用，也可同义改写，但不要机械堆砌。',
    ...STORY_HOT_WORD_GROUPS.map(group => `${group.label}：${group.words.join('、')}`),
    '使用规则：',
    '1. 书名优先采用“数字钩子/剧情词 + 强冲突 + 情绪词/人设词”的组合。',
    '2. 导语前三句必须落到一个可感知的热词场景，如彩礼、隐忍、揭穿、下跪、反击、马甲掉落。',
    '3. 核心设定中的主角标签、反派行为、爽点清算需要能反哺书名热词。',
    '4. 若题材不适配某类热词，可不使用该类，但至少提炼同等强度的数字、情绪、人设或剧情钩子。'
  ].join('\n')
}
