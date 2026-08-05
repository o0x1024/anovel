import assert from 'node:assert/strict'
import type { ParsedReportSection } from '../src/main/context/settings-quality'
import {
  buildNovelSettingsRepairTasks,
  formatNovelSettingsRepairTask
} from '../src/main/context/goal-routine/novel-settings-repair-plan'

const sections: ParsedReportSection[] = [
  {
    title: '主角设计 · 问题 / 建议',
    content: '阻塞：主角底线与终局选择互相矛盾。',
    reviseType: 'protagonist',
    severity: 'blocking'
  },
  {
    title: '爽点机制 · 问题 / 建议',
    content: '建议：增加阶段性兑现。',
    reviseType: 'pleasure_engine',
    severity: 'advisory'
  },
  {
    title: '跨设定矛盾 · 问题 / 建议',
    content: '阻塞：能力边界与世界规则冲突。',
    action: 'revise-cross',
    severity: 'blocking'
  },
  {
    title: '卡片与 Markdown 一致性 · 问题 / 建议',
    content: '阻塞：角色卡遗漏主角底线。',
    action: 'revise-cards',
    severity: 'blocking'
  }
]

const tasks = buildNovelSettingsRepairTasks(sections)
assert.deepEqual(
  tasks.map(task => task.settingType),
  [
    'protagonist',
    'golden_finger',
    'world_pressure',
    'conflict_engine',
    'pleasure_engine',
    'supporting_cast'
  ]
)

const protagonistTask = tasks[0]
assert.equal(protagonistTask.requiresCrossContext, true)
assert.equal(protagonistTask.reportSections.length, 2)
assert.match(formatNovelSettingsRepairTask(protagonistTask), /主角底线与终局选择/)
assert.match(formatNovelSettingsRepairTask(protagonistTask), /能力边界与世界规则/)

const pleasureTask = tasks.find(task => task.settingType === 'pleasure_engine')
assert(pleasureTask)
assert.equal(pleasureTask.reportSections.some(section => section.content.includes('阶段性兑现')), false)

assert.deepEqual(buildNovelSettingsRepairTasks([
  {
    title: '主角设计 · 问题 / 建议',
    content: '建议：补充动作锚点。',
    reviseType: 'protagonist',
    severity: 'advisory'
  }
]), [])

console.log('novel settings repair plan tests passed')
