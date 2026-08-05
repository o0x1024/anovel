import assert from 'node:assert/strict'
import { parseChapterSuggestions } from '../src/main/context/parse-chapters'
import {
  StoryCandidateFailureError,
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from '../src/main/context/goal-routine/story-structural-repair-policy'
import { resolveGenerationMaxTokens } from '../src/main/model/generation-token-budget'

assert.equal(resolveGenerationMaxTokens(undefined, 5250), 5250)
assert.equal(resolveGenerationMaxTokens(undefined, 15360), 15360)
assert.equal(resolveGenerationMaxTokens(12000, 5250), 5250)
assert.equal(resolveGenerationMaxTokens(2600, 5250), 2600)
assert.equal(resolveGenerationMaxTokens(2600.9, 5250.9), 2600)
assert.equal(resolveGenerationMaxTokens(0, 5250), 5250)

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
assert.notEqual(
  routineFailureSignature(
    'draft_body',
    new StoryCandidateFailureError('正文确定性门禁未通过：正文存在孤立引号行', 'BODY_TEXT_INTEGRITY:chapter:7:candidate:10:aaa:evidence:4:111')
  ),
  routineFailureSignature(
    'draft_body',
    new StoryCandidateFailureError('正文确定性门禁未通过：正文存在未闭合中文引号', 'BODY_TEXT_INTEGRITY:chapter:7:candidate:12:bbb:evidence:4:222')
  )
)
assert.equal(
  routineFailureSignature(
    'draft_body',
    new StoryCandidateFailureError('第一次错误文案', 'BODY_TEXT_INTEGRITY:chapter:7:candidate:10:aaa:evidence:4:111')
  ),
  routineFailureSignature(
    'draft_body',
    new StoryCandidateFailureError('第二次错误文案', 'BODY_TEXT_INTEGRITY:chapter:7:candidate:10:aaa:evidence:4:111')
  )
)
assert.equal(
  routineFailureSignature('draft_body', new Error('叙事记忆提取连续3轮未通过：证据错误')),
  'draft_body:MEMORY_EXTRACTION'
)
assert.equal(
  routineFailureSignature('generate_beats', new Error('Your account 2106272765 has not activated the model. Request id: 0217abcde1')),
  routineFailureSignature('generate_beats', new Error('Your account 2106272765 has not activated the model. Request id: 0217fedcb9'))
)

console.log('story structural repair policy tests passed')
