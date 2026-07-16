import assert from 'node:assert/strict'
import { parseChapterSuggestions } from '../src/main/context/parse-chapters'
import {
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from '../src/main/context/goal-routine/story-structural-repair-policy'

assert.equal(structuralRepairTokenBudget(22528, 1, 1), 6000)
assert.equal(structuralRepairTokenBudget(22528, 1, 2), 12000)
assert.equal(structuralRepairTokenBudget(22528, 2, 1), 9500)
assert.equal(structuralRepairTokenBudget(5250, 1, 1), 5250)
assert.equal(structuralRepairTokenBudget(5250, 1, 2), 5250)

const truncated = classifyStructuralRepairParseFailure({
  content: '{"chapters":[{"id":1123,"title":"原题"',
  completionTokens: 2600,
  maxTokens: 2600
})
assert.equal(truncated.code, 'STRUCTURE_RESPONSE_TRUNCATED')

const providerReportedTruncation = classifyStructuralRepairParseFailure({
  content: 'not-even-json',
  completionTokens: 0,
  maxTokens: 6000,
  finishReason: 'length'
})
assert.equal(providerReportedTruncation.code, 'STRUCTURE_RESPONSE_TRUNCATED')

const invalid = classifyStructuralRepairParseFailure({
  content: '这里是一些无法解析的说明',
  completionTokens: 120,
  maxTokens: 6000
})
assert.equal(invalid.code, 'STRUCTURE_JSON_INVALID')

const parsed = parseChapterSuggestions(JSON.stringify({
  chapters: [{
    id: 1123,
    title: '权力压案',
    plot_points: ['承接上一拍', '对手压案', '主角调整计划']
  }]
}))
assert.equal(parsed.length, 1)
assert.equal(parsed[0].id, 1123)
assert.equal(parsed[0].title, '权力压案')

assert.equal(
  routineFailureSignature('repair_execute', new Error('输出达到 2600 token')),
  routineFailureSignature('repair_execute', new Error('输出达到 12000 token'))
)
assert.equal(
  routineFailureSignature('draft_body', new Error('正文确定性门禁未通过：正文存在孤立引号行')),
  routineFailureSignature('draft_body', new Error('正文确定性门禁未通过：正文存在未闭合中文引号'))
)
assert.equal(
  routineFailureSignature('draft_body', new Error('叙事记忆提取连续3轮未通过：证据错误')),
  'draft_body:MEMORY_EXTRACTION'
)

console.log('story structural repair policy tests passed')
