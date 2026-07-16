import assert from 'node:assert/strict'
import {
  parseJsonObjectWithRepairs,
  repairMissingArrayClosuresBeforeProperties
} from '../src/shared/model-json-repair'

const missingArrayClose = '{"passed":true,"engine":{"causal_escalation":["第一步","第二步","midpoint_choice_and_cost":"付出代价","fair_clues_and_payoffs":["伏笔"]}}'
const repaired = parseJsonObjectWithRepairs<Record<string, unknown>>(missingArrayClose, {
  arrayBeforeProperties: ['midpoint_choice_and_cost']
})
assert.deepEqual(
  (repaired.value.engine as { causal_escalation: string[] }).causal_escalation,
  ['第一步', '第二步']
)
assert.ok(repaired.repairs.includes('closed_array_before:midpoint_choice_and_cost'))

// 2026-07-16 实际故障形态：正常 stop，但 causal_escalation 后漏写 `]`。
const productionShape = '{"passed":true,"score":91,"blocking_issues":[],"engine":{"genre_mode":"豪门爽文","protagonist_desire":"自证","inner_need":"摆脱认可依赖","opponent_desire":"保住控制权","central_dilemma":"公开真相会失去亲情","ability_boundary_and_cost":"证据有限且公开有代价","causal_escalation":["被冒名","主动复核","对手施压","公开原件","midpoint_choice_and_cost":"放弃私下和解","climax_choice_and_cost":"承担决裂代价并公开","ending_change_and_aftertaste":"赢得结果但失去家庭","fair_clues_and_payoffs":["成绩单水印","监控时间戳"]}}'
const productionRepaired = parseJsonObjectWithRepairs<Record<string, unknown>>(productionShape, {
  arrayBeforeProperties: ['midpoint_choice_and_cost']
})
assert.equal(
  ((productionRepaired.value.engine as Record<string, unknown>).causal_escalation as unknown[]).length,
  4
)

const alreadyValid = '{"items":["a","b"],"next":"ok"}'
const unchanged = repairMissingArrayClosuresBeforeProperties(alreadyValid, ['next'])
assert.equal(unchanged.text, alreadyValid)
assert.deepEqual(unchanged.repairs, [])

const propertyNameAsValue = '{"items":["next","still an item"]}'
assert.equal(repairMissingArrayClosuresBeforeProperties(propertyNameAsValue, ['next']).text, propertyNameAsValue)

const missingTail = parseJsonObjectWithRepairs<{ blockers: string[] }>('{"blockers":[]')
assert.deepEqual(missingTail.value.blockers, [])
assert.ok(missingTail.repairs.some(item => item.startsWith('appended_trailing_closures:')))

assert.throws(() => parseJsonObjectWithRepairs('{"items":["被截断的字符串'))
assert.throws(() => parseJsonObjectWithRepairs('{"items":['))

console.log('model JSON deterministic repair tests passed')
