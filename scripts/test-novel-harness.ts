import assert from 'node:assert/strict'
import {
  selectRelevantStoryFacts,
  selectRelevantTimelineEvents
} from '../src/main/context/novel-memory-retrieval'
import { validateStateFactEvidence, type ExtractedMemory } from '../src/main/context/memory-extract'
import { TARGET_WORD_PRESETS } from '../src/shared/writing-plan-presets'

assert(TARGET_WORD_PRESETS.includes(4_000_000))

const facts = [
  {
    chapter_id: 1,
    entity: '沈砚',
    state_key: '身份',
    value_json: '"学生"',
    transition: 'create',
    irreversible: 0,
    evidence: '我是附中的学生'
  },
  {
    chapter_id: 2,
    entity: '旧任务',
    state_key: '状态',
    value_json: '"完成"',
    transition: 'complete',
    irreversible: 1,
    evidence: '旧任务已经完成'
  },
  {
    chapter_id: 10,
    entity: '沈砚',
    state_key: '身份',
    value_json: '"调查员"',
    transition: 'update',
    irreversible: 1,
    evidence: '调查员证件压在桌上'
  },
  ...Array.from({ length: 60 }, (_, index) => ({
    chapter_id: 20 + index,
    entity: `路人${index}`,
    state_key: '位置',
    value_json: `"地点${index}"`,
    transition: 'update',
    irreversible: 0,
    evidence: `路人${index}到了地点${index}`
  }))
]

const selected = selectRelevantStoryFacts(facts, '沈砚以调查员身份进入仓库', ['沈砚'], 12)
assert(selected.some(fact => fact.entity === '沈砚' && fact.value_json.includes('调查员')))
assert(!selected.some(fact => fact.entity === '沈砚' && fact.value_json.includes('学生')))
assert(selected.length <= 12)

const timeline = Array.from({ length: 40 }, (_, index) => ({
  event_name: index === 3 ? '沈砚取得证件' : `事件${index}`,
  event_description: index === 3 ? '沈砚成为调查员' : `普通事件${index}`,
  absolute_time: null,
  relative_time: `第${index}天`
}))
const selectedTimeline = selectRelevantTimelineEvents(timeline, '沈砚使用调查员证件', ['沈砚'], 12)
assert(selectedTimeline.some(event => event.event_name === '沈砚取得证件'))
assert(selectedTimeline.some(event => event.event_name === '事件39'))
assert(selectedTimeline.length <= 12)

const extracted: ExtractedMemory = {
  foreshadowing_planted: [],
  foreshadowing_resolved: [],
  character_snapshots: [],
  timeline_events: [{ event_name: '取得证件' }],
  state_facts: [{
    entity: '沈砚',
    key: '身份',
    valueType: 'enum',
    value: '调查员',
    transition: 'update',
    irreversible: true,
    evidence: '调查员证件压在桌上'
  }]
}
assert.deepEqual(validateStateFactEvidence(extracted, '他没有解释，只把调查员证件压在桌上。'), [])
assert.match(
  validateStateFactEvidence(extracted, '桌上什么都没有。')[0],
  /不是正文原文片段/
)

process.stdout.write('novel harness tests passed\n')
