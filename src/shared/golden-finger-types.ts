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
  abilities: GoldenFingerAbility[]
  acquisition: string
  limit: GoldenFingerLimit
  backlash: string
  upgrades: GoldenFingerUpgrade[]
  infoAdvantage: string
  sideEffects: string
  forbiddenScenes: string
  tagline: string
  firstPayoffScene: string
  visualMetric: GoldenFingerVisualMetric
}

export const EMPTY_GOLDEN_FINGER: GoldenFingerStructured = {
  nameAndForm: '',
  abilities: [{ name: '', effect: '', scope: '' }],
  acquisition: '',
  limit: { cooldown: '', cost: '', usageLimit: '', invalidScenes: '' },
  backlash: '',
  upgrades: [{ stage: '', condition: '', unlocks: '' }],
  infoAdvantage: '',
  sideEffects: '',
  forbiddenScenes: '',
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
  return {
    nameAndForm: value.nameAndForm ?? '',
    abilities: (value.abilities ?? []).map(safeAbility),
    acquisition: value.acquisition ?? '',
    limit: {
      cooldown: value.limit?.cooldown ?? '',
      cost: value.limit?.cost ?? '',
      usageLimit: value.limit?.usageLimit ?? '',
      invalidScenes: value.limit?.invalidScenes ?? ''
    },
    backlash: value.backlash ?? '',
    upgrades: (value.upgrades ?? []).map(safeUpgrade),
    infoAdvantage: value.infoAdvantage ?? '',
    sideEffects: value.sideEffects ?? '',
    forbiddenScenes: value.forbiddenScenes ?? '',
    tagline: value.tagline ?? '',
    firstPayoffScene: value.firstPayoffScene ?? '',
    visualMetric: {
      currentLevel: value.visualMetric?.currentLevel ?? '',
      costPerUse: value.visualMetric?.costPerUse ?? '',
      cooldown: value.visualMetric?.cooldown ?? '',
      usageCap: value.visualMetric?.usageCap ?? '',
      progressBar: value.visualMetric?.progressBar ?? '',
      failureScene: value.visualMetric?.failureScene ?? ''
    }
  }
}

export function renderGoldenFingerMarkdown(gf: GoldenFingerStructured): string {
  const lines: string[] = []

  if (gf.tagline.trim()) lines.push('## 番茄一句话卖点', gf.tagline, '')
  if (gf.nameAndForm.trim()) lines.push('## 名称与形态', gf.nameAndForm, '')

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
  for (const a of gf.abilities.filter(x => x.name.trim() || x.effect.trim())) {
    lines.push(`- ${a.name || '能力'}：${a.effect}${a.scope ? `（范围：${a.scope}）` : ''}`)
  }
  lines.push(`获取/觉醒：${gf.acquisition}`)
  lines.push(`限制：冷却=${gf.limit.cooldown || '无'}；消耗=${gf.limit.cost || '无'}；上限=${gf.limit.usageLimit || '无'}；失效场景=${gf.limit.invalidScenes || '无'}`)
  lines.push(`反噬：${gf.backlash}`)
  lines.push(`信息差：${gf.infoAdvantage}`)
  if (gf.sideEffects.trim()) lines.push(`副作用：${gf.sideEffects}`)
  if (gf.forbiddenScenes.trim()) lines.push(`红线：${gf.forbiddenScenes}`)
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
    '  "abilities": [{ "name": "能力名", "effect": "具体效果", "scope": "作用范围" }],',
    '  "acquisition": "获取与觉醒条件",',
    '  "limit": { "cooldown": "冷却/间隔", "cost": "消耗", "usageLimit": "次数/容量上限", "invalidScenes": "失效场景" },',
    '  "backlash": "反噬/代价机制",',
    '  "upgrades": [{ "stage": "阶段名", "condition": "升级条件", "unlocks": "解锁能力" }],',
    '  "infoAdvantage": "信息差优势",',
    '  "sideEffects": "副作用/负面绑定",',
    '  "forbiddenScenes": "禁用/红线场景",',
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

