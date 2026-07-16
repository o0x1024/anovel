import assert from 'node:assert/strict'
import {
  EmotionLedgerParseError,
  parseEmotionLedgerResponse
} from '../src/main/context/goal-routine/emotion-ledger'

const valid = parseEmotionLedgerResponse(JSON.stringify({
  states: [{
    character_name: '林夏',
    felt_state: '警惕中夹杂内疚',
    displayed_state: '语气强硬',
    unresolved_emotion: '害怕再次失去队友',
    protective_strategy: '先控制距离',
    behavioral_aftereffect: '下一章会优先确认队友退路',
    belief_changes: [{ belief: '学校仍然安全', change: '动摇' }],
    relationship_changes: [{ character: '周明', state: '信任上升' }],
    source_event: '周明留下断后'
  }]
}))
assert.equal(valid.length, 1)
assert.equal(valid[0].belief_changes[0].change, '动摇')

const fenced = parseEmotionLedgerResponse(`以下为结果：
\`\`\`json
${JSON.stringify({ states: [{
    character_name: '林夏', felt_state: '不安', displayed_state: '', unresolved_emotion: '',
    protective_strategy: '', behavioral_aftereffect: '会反复检查门锁',
    belief_changes: [], relationship_changes: [], source_event: '听见门外异响'
  }] })}
\`\`\``)
assert.equal(fenced[0].character_name, '林夏')

const legacy = parseEmotionLedgerResponse(JSON.stringify({
  states: [{
    character_name: '林夏', felt_state: '愧疚', displayed_state: '沉默', unresolved_emotion: '',
    protective_strategy: '转移话题', behavioral_aftereffect: '避免直视周明',
    beliefs: { '只能依靠自己': '减弱' }, relationships: { '周明': '信任上升' }, source_event: '周明主动承担风险'
  }]
}))
assert.deepEqual(legacy[0].belief_changes, [{ belief: '只能依靠自己', change: '减弱' }])

assert.throws(
  () => parseEmotionLedgerResponse('{"states":[{"character_name" "林夏"}]}'),
  (error: unknown) => error instanceof EmotionLedgerParseError
    && error.message.includes('JSON语法无效')
    && error.outputExcerpt.length > 0
)

assert.throws(
  () => parseEmotionLedgerResponse('{"states":[{"character_name":"林夏","felt_state":"她说"我没事"但很害怕"}]}'),
  (error: unknown) => error instanceof EmotionLedgerParseError
    && error.message.includes('JSON语法无效')
)

assert.throws(
  () => parseEmotionLedgerResponse(JSON.stringify({ states: [{ character_name: '林夏' }] })),
  (error: unknown) => error instanceof EmotionLedgerParseError
    && error.message.includes('felt_state')
)

assert.throws(
  () => parseEmotionLedgerResponse('{"states":[]}'),
  (error: unknown) => error instanceof EmotionLedgerParseError
    && error.message.includes('不得为空')
)

process.stdout.write('emotion ledger parser tests passed\n')
