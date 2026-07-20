import assert from 'node:assert/strict'
import {
  applySentencePatches,
  planSceneRewriteBlocks,
  planStableRewriteBlocks,
  preservesStableSentenceTopology,
  splitStableSentences
} from '../src/shared/aigc-sentence-patches'
import type { AigcSentencePatch } from '../src/shared/aigc-sentence-rewrite-types'
import { parseSentenceAssessments } from '../src/main/context/lab/aigc-sentence-assessment'

const original = '第一句。\n“第二句！” 她说。\n最后一句'
const units = splitStableSentences(original)
assert.deepEqual(units.map(item => item.text), ['第一句。\n', '“第二句！” ', '她说。\n', '最后一句'])
assert.equal(units[0].id, `sentence:0:${units[0].end}`)

const blocks = planStableRewriteBlocks(units)
assert.deepEqual(blocks.map(block => block.sentenceIds.length), [4])
assert.equal(blocks.map(block => block.text).join(''), original)
assert.ok(blocks.every(block => block.id.startsWith('block:')))

const sceneUnits = splitStableSentences(
  '第一段的环境信息很长，需要和人物动作一起组织。第二句继续推进人物动作。\n“你先走。”\n他没有回答。第四句补充现场变化。第五句收住场景。'
)
const sceneBlocks = planSceneRewriteBlocks(sceneUnits, {
  targetCharacters: 80,
  maximumCharacters: 160,
  maximumSentences: 4
})
assert.equal(sceneBlocks.map(block => block.text).join(''), sceneUnits.map(unit => unit.text).join(''))
assert.ok(sceneBlocks.every(block => block.id.startsWith('scene:')))
assert.ok(sceneBlocks.every(block => block.sentenceIds.length <= 4))

const patches: AigcSentencePatch[] = [units[0], units[3]].map((unit, index) => ({
  ...unit,
  originalText: unit.text,
  segmentIndex: 0,
  rewrittenText: index === 0 ? '开头一句。\n' : '收尾。',
  status: 'passed',
  sceneTypes: ['narration'],
  aiSymptoms: ['regular_sentence_rhythm'],
  evidence: '测试',
  referenceTitles: [],
  issues: [],
  windowScoreBefore: 60,
  windowScoreAfter: 50
}))

assert.equal(
  applySentencePatches(original, patches, patches.map(item => item.id)),
  '开头一句。\n“第二句！” 她说。\n收尾。'
)
assert.equal(applySentencePatches(original, patches, [patches[0].id]), '开头一句。\n“第二句！” 她说。\n最后一句')

const blockPatch: AigcSentencePatch = {
  id: blocks[0].id,
  scope: 'block',
  sentenceCount: blocks[0].sentenceIds.length,
  start: blocks[0].start,
  end: blocks[0].end,
  segmentIndex: 0,
  paragraphIndex: blocks[0].paragraphIndex,
  sentenceIndex: blocks[0].sentenceIndex,
  originalText: blocks[0].text,
  rewrittenText: '四句被联合重构成三句。仍然保持完整。最后收住。',
  status: 'passed',
  sceneTypes: ['narration'],
  aiSymptoms: ['regular_sentence_rhythm'],
  evidence: '块级测试',
  referenceTitles: [],
  issues: [],
  windowScoreBefore: 70,
  windowScoreAfter: 30
}
assert.equal(
  applySentencePatches(original, [blockPatch], [blockPatch.id]),
  blockPatch.rewrittenText,
  '语义块补丁必须允许块内重新分句并按原始块范围稳定应用'
)

const adjacentSentences = '他放下杯子。她没有说话。'
assert.equal(
  preservesStableSentenceTopology(adjacentSentences, 0, '他放下杯子。'.length, '他把杯子放下。'),
  true,
  '保留句末终止符的替换应维持稳定句界'
)
assert.equal(
  preservesStableSentenceTopology(adjacentSentences, 0, '他放下杯子。'.length, '他把杯子放下'),
  false,
  '候选单独看似一句，但缺少句末终止符时会与下一句合并，必须提前拒绝'
)
assert.equal(
  preservesStableSentenceTopology(adjacentSentences, 0, '他放下杯子。'.length, '他放下杯子。接着看向门口。'),
  false,
  '把一个目标句拆成两句必须提前拒绝'
)

const unchangedAssessment = parseSentenceAssessments(JSON.stringify({
  items: [{
    id: 0,
    shouldRewrite: false,
    sceneTypes: ['environment'],
    aiSymptoms: [],
    evidence: '',
    factAnchors: []
  }]
}), 1).get(0)
assert.equal(unchangedAssessment?.shouldRewrite, false, '无需改写是合法分类结果，不能因症状和证据为空被丢弃')
assert.deepEqual(unchangedAssessment?.aiSymptoms, [])

const rewriteAssessment = parseSentenceAssessments(JSON.stringify({
  items: [{
    id: 0,
    shouldRewrite: true,
    sceneTypes: ['action'],
    aiSymptoms: ['shot_chain'],
    evidence: '连续逐帧动作',
    factAnchors: ['短刀']
  }]
}), 1, new Set(), ['他攥着短刀连续移动。']).get(0)
assert.equal(rewriteAssessment?.shouldRewrite, true)
assert.deepEqual(rewriteAssessment?.factAnchors, ['短刀'])

assert.throws(
  () => parseSentenceAssessments(JSON.stringify({
    items: [{
      id: 0,
      shouldRewrite: true,
      sceneTypes: ['action'],
      aiSymptoms: ['shot_chain'],
      evidence: '连续动作',
      factAnchors: ['不存在的物件']
    }]
  }), 1, new Set([0]), ['他攥着短刀连续移动。']),
  /不是原句原文/,
  '模型虚构的事实锚点必须被严格拒绝'
)

assert.throws(
  () => parseSentenceAssessments(JSON.stringify({
    items: [{
      id: 0,
      shouldRewrite: false,
      sceneTypes: ['action'],
      aiSymptoms: [],
      evidence: '',
      factAnchors: []
    }]
  }), 1, new Set([0])),
  /检测器确认的红色句子/,
  '红色句子由检测器确定为必改目标，分类模型不能再次否决'
)

assert.throws(
  () => parseSentenceAssessments(JSON.stringify({
    items: [{ id: 0, shouldRewrite: true, sceneTypes: ['action'], aiSymptoms: [], evidence: '', factAnchors: [] }]
  }), 1),
  /id 0 需要改写但缺少 AI 症状/,
  '需要改写的句子仍必须提供可验证症状和证据'
)

assert.throws(
  () => parseSentenceAssessments(JSON.stringify({
    items: [{
      id: 0,
      shouldRewrite: true,
      sceneTypes: ['人物动作'],
      aiSymptoms: ['shot_chain'],
      evidence: '连续动作',
      factAnchors: []
    }]
  }), 1),
  /收到 \["人物动作"\]/,
  '非法场景枚举必须保留原值供严格重试反馈，不能静默兼容映射'
)

console.log('AIGC stable sentence patch tests passed')
