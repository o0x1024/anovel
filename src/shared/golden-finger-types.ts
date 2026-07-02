/**
 * 金手指结构化 Schema（番茄网文最佳实践）
 *
 * 目标：把自由 Markdown 转为可校验、可注入正文的结构化数据，
 * 从源头减少正文生成时的能力边界、限制条件、升级节奏等 bug。
 */

export interface GoldenFingerAbility {
  name: string
  effect: string
  scope: string
}

export interface GoldenFingerLimit {
  cooldown?: string
  cost?: string
  usageLimit?: string
  invalidScenes?: string
}

export interface GoldenFingerUpgrade {
  stage: string
  condition: string
  unlocks: string
}

export interface GoldenFingerVisualMetric {
  currentLevel: string
  costPerUse: string
  cooldown: string
  usageCap: string
  progressBar: string
  failureScene: string
}

export interface GoldenFingerStructured {
  nameAndForm: string
  manifestation: string
  visibility: string
  interaction: string
  abilities: GoldenFingerAbility[]
  acquisition: string
  sourceNature: string
  limit: GoldenFingerLimit
  backlash: string
  upgrades: GoldenFingerUpgrade[]
  infoAdvantage: string
  sideEffects: string
  forbiddenScenes: string
  exposureConsequence: string
  tagline: string
  firstPayoffScene: string
  visualMetric: GoldenFingerVisualMetric
}

export const EMPTY_GOLDEN_FINGER: GoldenFingerStructured = {
  nameAndForm: '',
  manifestation: '',
  visibility: '',
  interaction: '',
  abilities: [{ name: '', effect: '', scope: '' }],
  acquisition: '',
  sourceNature: '',
  limit: { cooldown: '', cost: '', usageLimit: '', invalidScenes: '' },
  backlash: '',
  upgrades: [{ stage: '', condition: '', unlocks: '' }],
  infoAdvantage: '',
  sideEffects: '',
  forbiddenScenes: '',
  exposureConsequence: '',
  tagline: '',
  firstPayoffScene: '',
  visualMetric: {
    currentLevel: '',
    costPerUse: '',
    cooldown: '',
    usageCap: '',
    progressBar: '',
    failureScene: ''
  }
}

export function isGoldenFingerStructured(value: unknown): value is GoldenFingerStructured {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<GoldenFingerStructured>
  return typeof v.nameAndForm === 'string'
    && Array.isArray(v.abilities)
    && typeof v.acquisition === 'string'
    && v.limit !== null && typeof v.limit === 'object'
    && typeof v.backlash === 'string'
    && Array.isArray(v.upgrades)
    && typeof v.infoAdvantage === 'string'
    && typeof v.tagline === 'string'
    && typeof v.firstPayoffScene === 'string'
    && v.visualMetric !== null && typeof v.visualMetric === 'object'
}

export function normalizeGoldenFinger(value: Partial<GoldenFingerStructured>): GoldenFingerStructured {
  const safeAbility = (a?: Partial<GoldenFingerAbility>) => ({
    name: a?.name ?? '',
    effect: a?.effect ?? '',
    scope: a?.scope ?? ''
  })
  const safeUpgrade = (u?: Partial<GoldenFingerUpgrade>) => ({
    stage: u?.stage ?? '',
    condition: u?.condition ?? '',
    unlocks: u?.unlocks ?? ''
  })
  const safeStr = (v: unknown): string => {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(item => typeof item === 'string' ? item : String(item)).join('\n')
    if (v != null && typeof v === 'object') return JSON.stringify(v)
    return ''
  }
  return {
    nameAndForm: safeStr(value.nameAndForm),
    manifestation: safeStr(value.manifestation),
    visibility: safeStr(value.visibility),
    interaction: safeStr(value.interaction),
    abilities: (value.abilities ?? []).map(safeAbility),
    acquisition: safeStr(value.acquisition),
    sourceNature: safeStr(value.sourceNature),
    limit: {
      cooldown: safeStr(value.limit?.cooldown),
      cost: safeStr(value.limit?.cost),
      usageLimit: safeStr(value.limit?.usageLimit),
      invalidScenes: safeStr(value.limit?.invalidScenes)
    },
    backlash: safeStr(value.backlash),
    upgrades: (value.upgrades ?? []).map(safeUpgrade),
    infoAdvantage: safeStr(value.infoAdvantage),
    sideEffects: safeStr(value.sideEffects),
    forbiddenScenes: safeStr(value.forbiddenScenes),
    exposureConsequence: safeStr(value.exposureConsequence),
    tagline: safeStr(value.tagline),
    firstPayoffScene: safeStr(value.firstPayoffScene),
    visualMetric: {
      currentLevel: safeStr(value.visualMetric?.currentLevel),
      costPerUse: safeStr(value.visualMetric?.costPerUse),
      cooldown: safeStr(value.visualMetric?.cooldown),
      usageCap: safeStr(value.visualMetric?.usageCap),
      progressBar: safeStr(value.visualMetric?.progressBar),
      failureScene: safeStr(value.visualMetric?.failureScene)
    }
  }
}

export function renderGoldenFingerMarkdown(gf: GoldenFingerStructured): string {
  const lines: string[] = []

  if (gf.tagline.trim()) lines.push('## 番茄一句话卖点', gf.tagline, '')
  if (gf.nameAndForm.trim()) lines.push('## 名称与形态', gf.nameAndForm, '')
  if (gf.manifestation.trim()) lines.push('## 呈现形式', gf.manifestation, '')
  if (gf.visibility.trim()) lines.push('## 外人可见性', gf.visibility, '')
  if (gf.interaction.trim()) lines.push('## 交互方式', gf.interaction, '')

  const abilities = gf.abilities.filter(a => a.name.trim() || a.effect.trim())
  if (abilities.length) {
    lines.push('## 核心能力')
    for (const a of abilities) {
      lines.push(`- **${a.name.trim() || '能力'}**：${a.effect.trim() || '（待填写）'}`)
      if (a.scope.trim()) lines.push(`  - 作用范围：${a.scope}`)
    }
    lines.push('')
  }

  if (gf.acquisition.trim()) lines.push('## 获取方式与觉醒条件', gf.acquisition, '')
  if (gf.sourceNature.trim()) lines.push('## 来源性质', gf.sourceNature, '')

  const limit = gf.limit
  const hasLimit = limit.cooldown?.trim() || limit.cost?.trim() || limit.usageLimit?.trim() || limit.invalidScenes?.trim()
  if (hasLimit) {
    lines.push('## 限制条件')
    if (limit.cooldown?.trim()) lines.push(`- **冷却/间隔**：${limit.cooldown}`)
    if (limit.cost?.trim()) lines.push(`- **消耗**：${limit.cost}`)
    if (limit.usageLimit?.trim()) lines.push(`- **次数/容量上限**：${limit.usageLimit}`)
    if (limit.invalidScenes?.trim()) lines.push(`- **失效场景**：${limit.invalidScenes}`)
    lines.push('')
  }

  if (gf.backlash.trim()) lines.push('## 反噬机制', gf.backlash, '')

  const upgrades = gf.upgrades.filter(u => u.stage.trim() || u.condition.trim() || u.unlocks.trim())
  if (upgrades.length) {
    lines.push('## 升级路径')
    for (const u of upgrades) {
      const stage = u.stage.trim() || '阶段'
      const condition = u.condition.trim() || '（条件待填写）'
      const unlocks = u.unlocks.trim() || '（解锁待填写）'
      lines.push(`- **${stage}**：${condition} → ${unlocks}`)
    }
    lines.push('')
  }

  if (gf.infoAdvantage.trim()) lines.push('## 信息差优势', gf.infoAdvantage, '')
  if (gf.sideEffects.trim()) lines.push('## 副作用/负面绑定', gf.sideEffects, '')
  if (gf.forbiddenScenes.trim()) lines.push('## 禁用/红线场景', gf.forbiddenScenes, '')
  if (gf.exposureConsequence.trim()) lines.push('## 暴露后果', gf.exposureConsequence, '')

  const vm = gf.visualMetric
  const hasVm = vm.currentLevel?.trim() || vm.costPerUse?.trim() || vm.cooldown?.trim() ||
    vm.usageCap?.trim() || vm.progressBar?.trim() || vm.failureScene?.trim()
  if (hasVm) {
    lines.push('## 可视化限制指标（番茄核心）')
    if (vm.currentLevel?.trim()) lines.push(`- **当前等级/阶段**：${vm.currentLevel}`)
    if (vm.costPerUse?.trim()) lines.push(`- **每次使用消耗**：${vm.costPerUse}`)
    if (vm.cooldown?.trim()) lines.push(`- **冷却时间**：${vm.cooldown}`)
    if (vm.usageCap?.trim()) lines.push(`- **使用次数上限**：${vm.usageCap}`)
    if (vm.progressBar?.trim()) lines.push(`- **进度条形态**：${vm.progressBar}`)
    if (vm.failureScene?.trim()) lines.push(`- **越级/失效后果**：${vm.failureScene}`)
    lines.push('')
  }

  if (gf.firstPayoffScene.trim()) lines.push('## 前三章首次爽点场景', gf.firstPayoffScene, '')

  return lines.join('\n').trim()
}

const GOLDEN_FINGER_KEY_MAP: Record<string, string> = {
  名称与形态: 'nameAndForm',
  设定名称: 'nameAndForm',
  能力名称: 'nameAndForm',
  呈现形式: 'manifestation',
  呈现: 'manifestation',
  外显形态: 'manifestation',
  外人可见性: 'visibility',
  可见性: 'visibility',
  外显性: 'visibility',
  交互方式: 'interaction',
  交互: 'interaction',
  核心能力: 'abilities',
  能力: 'abilities',
  获取方式: 'acquisition',
  获取方式与觉醒条件: 'acquisition',
  觉醒条件: 'acquisition',
  来源性质: 'sourceNature',
  来源: 'sourceNature',
  限制条件: 'limit',
  限制: 'limit',
  反噬机制: 'backlash',
  反噬: 'backlash',
  代价机制: 'backlash',
  升级路径: 'upgrades',
  升级: 'upgrades',
  信息差优势: 'infoAdvantage',
  信息差: 'infoAdvantage',
  副作用: 'sideEffects',
  负面绑定: 'sideEffects',
  禁用场景: 'forbiddenScenes',
  红线场景: 'forbiddenScenes',
  禁用: 'forbiddenScenes',
  暴露后果: 'exposureConsequence',
  暴露: 'exposureConsequence',
  番茄一句话卖点: 'tagline',
  一句话卖点: 'tagline',
  卖点: 'tagline',
  前三章首次爽点场景: 'firstPayoffScene',
  首次爽点: 'firstPayoffScene',
  爽点场景: 'firstPayoffScene',
  可视化限制指标: 'visualMetric',
  可视化指标: 'visualMetric'
}

const LIMIT_KEY_MAP: Record<string, string> = {
  冷却: 'cooldown',
  冷却时间: 'cooldown',
  间隔: 'cooldown',
  消耗: 'cost',
  每次消耗: 'cost',
  每次使用消耗: 'cost',
  次数上限: 'usageLimit',
  容量上限: 'usageLimit',
  使用次数上限: 'usageLimit',
  使用次数: 'usageLimit',
  失效场景: 'invalidScenes'
}

const VISUAL_METRIC_KEY_MAP: Record<string, string> = {
  当前等级: 'currentLevel',
  等级: 'currentLevel',
  阶段: 'currentLevel',
  每次使用消耗: 'costPerUse',
  每次消耗: 'costPerUse',
  冷却时间: 'cooldown',
  使用次数上限: 'usageCap',
  进度条形态: 'progressBar',
  进度条: 'progressBar',
  越级后果: 'failureScene',
  失效后果: 'failureScene',
  越级: 'failureScene'
}

const ABILITY_KEY_MAP: Record<string, string> = {
  能力名: 'name',
  名称: 'name',
  具体效果: 'effect',
  效果: 'effect',
  作用范围: 'scope',
  范围: 'scope'
}

const UPGRADE_KEY_MAP: Record<string, string> = {
  阶段名: 'stage',
  阶段: 'stage',
  升级条件: 'condition',
  条件: 'condition',
  解锁能力: 'unlocks',
  解锁: 'unlocks'
}

function mapKeys(obj: Record<string, unknown>, keyMap: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const mapped = keyMap[key] ?? key
    result[mapped] = value
  }
  return result
}

function normalizeGoldenFingerKeys(input: Record<string, unknown>): Partial<GoldenFingerStructured> {
  const mapped = mapKeys(input, GOLDEN_FINGER_KEY_MAP)

  if (mapped.limit && typeof mapped.limit === 'object' && !Array.isArray(mapped.limit)) {
    mapped.limit = mapKeys(mapped.limit as Record<string, unknown>, LIMIT_KEY_MAP)
  }

  if (mapped.visualMetric && typeof mapped.visualMetric === 'object' && !Array.isArray(mapped.visualMetric)) {
    mapped.visualMetric = mapKeys(mapped.visualMetric as Record<string, unknown>, VISUAL_METRIC_KEY_MAP)
  }

  if (Array.isArray(mapped.abilities)) {
    mapped.abilities = mapped.abilities.map(a => {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        return mapKeys(a as Record<string, unknown>, ABILITY_KEY_MAP)
      }
      return a
    })
  }

  if (Array.isArray(mapped.upgrades)) {
    mapped.upgrades = mapped.upgrades.map(u => {
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        return mapKeys(u as Record<string, unknown>, UPGRADE_KEY_MAP)
      }
      return u
    })
  }

  return mapped as Partial<GoldenFingerStructured>
}

export function extractGoldenFingerFromAiContent(
  content: string
): { markdown: string; structured: GoldenFingerStructured } | null {
  const trimmed = content.trim()

  let jsonText = ''
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fencedMatch) {
    jsonText = fencedMatch[1].trim()
  } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    jsonText = trimmed
  } else {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/)
    if (objectMatch) jsonText = objectMatch[0]
  }

  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const withEnglishKeys = normalizeGoldenFingerKeys(parsed)
    const structured = normalizeGoldenFinger(withEnglishKeys)
    let markdown = fencedMatch ? trimmed.replace(fencedMatch[0], '').trim() : ''
    if (!markdown) markdown = renderGoldenFingerMarkdown(structured)
    return { markdown, structured }
  } catch {
    return null
  }
}

function parseListItems(body: string): string[] {
  return body.split(/\n/).reduce<string[]>((acc, line) => {
    const trimmed = line.trim()
    if (!trimmed) return acc
    if (/^[-*]\s+/.test(trimmed)) {
      acc.push(trimmed.replace(/^[-*]\s+/, ''))
    }
    return acc
  }, [])
}

function parseBoldItem(item: string): { key: string; value: string } | null {
  const match = item.match(/^\*\*(.+?)\*\*[:：]?\s*(.*)$/s)
  if (!match) return null
  return { key: match[1].trim(), value: match[2].trim() }
}

/** 从旧 Markdown 做最佳努力解析（不保证完整） */
export function parseGoldenFingerFromMarkdown(content: string): GoldenFingerStructured {
  const gf = normalizeGoldenFinger({})
  if (!content?.trim()) return gf

  const sections = content.split(/^## /m).map(s => s.trim()).filter(Boolean)
  for (const section of sections) {
    const [titleLine, ...bodyLines] = section.split('\n')
    const title = titleLine.replace(/^#+\s*/, '').trim()
    const body = bodyLines.join('\n').trim()

    if (title.includes('名称与形态')) {
      gf.nameAndForm = body
    } else if (title.includes('呈现形式') || title.includes('外显形态')) {
      gf.manifestation = body
    } else if (title.includes('外人可见性') || title.includes('可见性')) {
      gf.visibility = body
    } else if (title.includes('交互方式') || title.includes('交互')) {
      gf.interaction = body
    } else if (title.includes('核心能力')) {
      gf.abilities = parseListItems(body).map(item => {
        const parsed = parseBoldItem(item)
        if (!parsed) return { name: '', effect: item, scope: '' }
        const scopeMatch = parsed.value.match(/作用范围[:：]?\s*(.+)/)
        return {
          name: parsed.key,
          effect: scopeMatch ? parsed.value.split('作用范围')[0].trim() : parsed.value,
          scope: scopeMatch?.[1]?.trim() ?? ''
        }
      })
    } else if (title.includes('获取') || title.includes('觉醒')) {
      gf.acquisition = body
    } else if (title.includes('来源性质') || title.includes('来源')) {
      gf.sourceNature = body
    } else if (title.includes('限制条件')) {
      for (const item of parseListItems(body)) {
        const parsed = parseBoldItem(item)
        if (!parsed) continue
        const key = parsed.key
        if (key.includes('冷却') || key.includes('间隔')) gf.limit.cooldown = parsed.value
        else if (key.includes('消耗')) gf.limit.cost = parsed.value
        else if (key.includes('次数') || key.includes('上限')) gf.limit.usageLimit = parsed.value
        else if (key.includes('失效')) gf.limit.invalidScenes = parsed.value
      }
    } else if (title.includes('反噬')) {
      gf.backlash = body
    } else if (title.includes('升级')) {
      gf.upgrades = parseListItems(body).map(item => {
        const parsed = parseBoldItem(item)
        if (!parsed) return { stage: '', condition: item, unlocks: '' }
        const parts = parsed.value.split('→').map(s => s.trim())
        return { stage: parsed.key, condition: parts[0] ?? '', unlocks: parts[1] ?? '' }
      })
    } else if (title.includes('信息差')) {
      gf.infoAdvantage = body
    } else if (title.includes('副作用') || title.includes('负面')) {
      gf.sideEffects = body
    } else if (title.includes('禁用') || title.includes('红线')) {
      gf.forbiddenScenes = body
    } else if (title.includes('暴露后果') || title.includes('暴露')) {
      gf.exposureConsequence = body
    } else if (title.includes('卖点')) {
      gf.tagline = body
    } else if (title.includes('爽点场景')) {
      gf.firstPayoffScene = body
    } else if (title.includes('可视化')) {
      for (const item of parseListItems(body)) {
        const parsed = parseBoldItem(item)
        if (!parsed) continue
        const key = parsed.key
        if (key.includes('等级') || key.includes('阶段')) gf.visualMetric.currentLevel = parsed.value
        else if (key.includes('消耗')) gf.visualMetric.costPerUse = parsed.value
        else if (key.includes('冷却')) gf.visualMetric.cooldown = parsed.value
        else if (key.includes('次数上限')) gf.visualMetric.usageCap = parsed.value
        else if (key.includes('进度条')) gf.visualMetric.progressBar = parsed.value
        else if (key.includes('失效') || key.includes('越级')) gf.visualMetric.failureScene = parsed.value
      }
    }
  }

  return gf
}

export function goldenFingerValidationIssues(gf: GoldenFingerStructured): string[] {
  const issues: string[] = []
  if (!gf.nameAndForm.trim()) issues.push('缺少「名称与形态」')
  if (!gf.manifestation.trim()) issues.push('缺少「呈现形式」')
  if (!gf.visibility.trim()) issues.push('缺少「外人可见性」')
  if (!gf.interaction.trim()) issues.push('缺少「交互方式」')
  if (!gf.abilities.some(a => a.name.trim() && a.effect.trim())) issues.push('缺少有效的「核心能力」')
  if (!gf.acquisition.trim()) issues.push('缺少「获取方式与觉醒条件」')
  if (!gf.limit.cooldown?.trim() && !gf.limit.cost?.trim() && !gf.limit.usageLimit?.trim()) {
    issues.push('缺少「使用限制」（冷却/消耗/次数至少填一项）')
  }
  if (!gf.backlash.trim()) issues.push('缺少「反噬/代价机制」')
  if (!gf.infoAdvantage.trim()) issues.push('缺少「信息差优势」')
  if (!gf.tagline.trim()) issues.push('缺少「番茄一句话卖点」')
  if (!gf.firstPayoffScene.trim()) issues.push('缺少「前三章首次爽点场景」')
  if (!gf.visualMetric.currentLevel?.trim()) issues.push('缺少「可视化限制指标-当前等级」')
  return issues
}

export function formatGoldenFingerConstraints(gf: GoldenFingerStructured): string {
  const issues = goldenFingerValidationIssues(gf)
  if (issues.length) {
    return `【金手指约束】\n当前金手指设定不完整：${issues.join('、')}。请在核心设定中补全后再生成正文。`
  }

  const lines: string[] = ['【金手指硬性约束】']
  lines.push(`能力：${gf.nameAndForm}`)
  lines.push(`呈现形式：${gf.manifestation}`)
  lines.push(`外人可见性：${gf.visibility}`)
  lines.push(`交互方式：${gf.interaction}`)
  for (const a of gf.abilities.filter(x => x.name.trim() || x.effect.trim())) {
    lines.push(`- ${a.name || '能力'}：${a.effect}${a.scope ? `（范围：${a.scope}）` : ''}`)
  }
  lines.push(`获取/觉醒：${gf.acquisition}`)
  if (gf.sourceNature.trim()) lines.push(`来源性质：${gf.sourceNature}`)
  lines.push(`限制：冷却=${gf.limit.cooldown || '无'}；消耗=${gf.limit.cost || '无'}；上限=${gf.limit.usageLimit || '无'}；失效场景=${gf.limit.invalidScenes || '无'}`)
  lines.push(`反噬：${gf.backlash}`)
  lines.push(`信息差：${gf.infoAdvantage}`)
  if (gf.sideEffects.trim()) lines.push(`副作用：${gf.sideEffects}`)
  if (gf.forbiddenScenes.trim()) lines.push(`红线：${gf.forbiddenScenes}`)
  if (gf.exposureConsequence.trim()) lines.push(`暴露后果：${gf.exposureConsequence}`)
  lines.push(`可视化指标：等级=${gf.visualMetric.currentLevel}；每次消耗=${gf.visualMetric.costPerUse}；冷却=${gf.visualMetric.cooldown}；次数上限=${gf.visualMetric.usageCap}；进度条=${gf.visualMetric.progressBar}；越级后果=${gf.visualMetric.failureScene}`)
  if (gf.upgrades.some(u => u.stage.trim())) {
    lines.push('升级路径：')
    for (const u of gf.upgrades.filter(x => x.stage.trim())) {
      lines.push(`- ${u.stage}：${u.condition} → ${u.unlocks}`)
    }
  }
  lines.push(`前三章爽点：${gf.firstPayoffScene}`)

  return lines.join('\n')
}

export function goldenFingerStructuredPromptSection(): string {
  return [
    '【输出格式要求】',
    '请在 Markdown 分析之后，附加一个 JSON 代码块（标记为 json），字段如下：',
    '{',
    '  "nameAndForm": "能力名称与形态",',
    '  "manifestation": "呈现形式：以什么形式呈现给主角（面板/声音/纹路/空间/物品/纯感知），感官通道，触发方式",',
    '  "visibility": "外人可见性：金手指本身是否可见、使用时是否有外在表现、世界观检测手段能否发现",',
    '  "interaction": "交互方式：主角如何调用金手指、金手指是否有自主意识/人格",',
    '  "abilities": [{ "name": "能力名", "effect": "具体效果", "scope": "作用范围" }],',
    '  "acquisition": "获取与觉醒条件",',
    '  "sourceNature": "来源性质：金手指的本质来源、在世界观中是否有同类、是否可被夺取/封印",',
    '  "limit": { "cooldown": "冷却/间隔", "cost": "消耗", "usageLimit": "次数/容量上限", "invalidScenes": "失效场景" },',
    '  "backlash": "反噬/代价机制",',
    '  "upgrades": [{ "stage": "阶段名", "condition": "升级条件", "unlocks": "解锁能力" }],',
    '  "infoAdvantage": "信息差优势",',
    '  "sideEffects": "副作用/负面绑定",',
    '  "forbiddenScenes": "禁用/红线场景",',
    '  "exposureConsequence": "暴露后果：金手指被他人发现后的后果、是否需要隐藏、是否有势力针对持有者",',
    '  "tagline": "番茄一句话卖点",',
    '  "firstPayoffScene": "前三章首次爽点场景",',
    '  "visualMetric": {',
    '    "currentLevel": "当前等级/阶段",',
    '    "costPerUse": "每次使用消耗",',
    '    "cooldown": "冷却时间",',
    '    "usageCap": "使用次数上限",',
    '    "progressBar": "进度条形态",',
    '    "failureScene": "越级/失效后果"',
    '  }',
    '}',
    'Markdown 正文用于展示；JSON 用于系统校验与正文生成注入。两者必须一致。'
  ].join('\n')
}

/**
 * 合并两个金手指结构化数据。
 * 原则：patch 中非空字段覆盖当前值；空字段保留当前值，避免部分 patch 把未提及的字段清空。
 */
export function mergeGoldenFinger(
  current: GoldenFingerStructured,
  patch: GoldenFingerStructured
): GoldenFingerStructured {
  const merged = normalizeGoldenFinger(current)

  const scalarFields: Array<keyof Omit<GoldenFingerStructured, 'abilities' | 'upgrades' | 'limit' | 'visualMetric'>> = [
    'nameAndForm', 'manifestation', 'visibility', 'interaction', 'acquisition', 'sourceNature', 'backlash', 'infoAdvantage', 'sideEffects', 'forbiddenScenes', 'exposureConsequence', 'tagline', 'firstPayoffScene'
  ]
  for (const key of scalarFields) {
    const value = patch[key]
    if (typeof value === 'string' && value.trim()) {
      (merged as Record<string, string>)[key] = value.trim()
    }
  }

  const limitKeys = Object.keys(merged.limit) as Array<keyof GoldenFingerLimit>
  for (const key of limitKeys) {
    if (patch.limit[key]?.trim()) {
      merged.limit[key] = patch.limit[key]
    }
  }

  const metricKeys = Object.keys(merged.visualMetric) as Array<keyof GoldenFingerVisualMetric>
  for (const key of metricKeys) {
    if (patch.visualMetric[key]?.trim()) {
      merged.visualMetric[key] = patch.visualMetric[key]
    }
  }

  const hasAbilities = patch.abilities.some(a => a.name.trim() || a.effect.trim())
  if (hasAbilities) {
    merged.abilities = patch.abilities.filter(a => a.name.trim() || a.effect.trim())
  }

  const hasUpgrades = patch.upgrades.some(u => u.stage.trim() || u.condition.trim() || u.unlocks.trim())
  if (hasUpgrades) {
    merged.upgrades = patch.upgrades.filter(u => u.stage.trim() || u.condition.trim() || u.unlocks.trim())
  }

  return merged
}

