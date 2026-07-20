import assert from 'node:assert/strict'
import type { HumanRewriteReference } from '../src/shared/human-rewrite-reference-types'
import {
  findCopiedReferencePhrase,
  formatHumanRewriteReferences,
  parseHumanRewriteAssessments,
  selectHumanRewriteReferences
} from '../src/main/context/lab/human-rewrite-reference'

function reference(
  id: number,
  sceneTypes: HumanRewriteReference['sceneTypes'],
  aiSymptoms: HumanRewriteReference['aiSymptoms'],
  priority: number
): HumanRewriteReference {
  return {
    id,
    title: `案例${id}`,
    sceneTypes,
    aiSymptoms,
    originalText: '他眼中闪过一丝惊讶，缓缓开口。',
    rewrittenText: '“你早知道？”他没再碰桌上的杯子。',
    rewritePrinciples: ['删除镜头链', '让动作承载关系变化'],
    preservedFacts: ['人物已经察觉真相'],
    forbiddenChanges: ['不得增加新人物'],
    enabled: true,
    priority,
    createTime: '2026-07-18 00:00:00',
    updateTime: '2026-07-18 00:00:00'
  }
}

const assessments = parseHumanRewriteAssessments(JSON.stringify({
  items: [{
    id: 3,
    sceneTypes: ['dialogue', 'psychology'],
    aiSymptoms: ['shot_chain', 'emotion_telling'],
    reason: '说话前连续描写眼神和嘴角，并直接解释惊讶'
  }]
}), [3])

assert.deepEqual(assessments.get(3)?.sceneTypes, ['dialogue', 'psychology'])
assert.deepEqual(assessments.get(3)?.aiSymptoms, ['shot_chain', 'emotion_telling'])

assert.throws(
  () => parseHumanRewriteAssessments('{"items":[]}', [3]),
  /分类结果不完整/,
  '缺少目标 ID 时必须拒绝，不能采用通用分类'
)

const matched = selectHumanRewriteReferences(assessments.get(3)!, [
  reference(1, ['dialogue'], ['shot_chain'], 40),
  reference(2, ['dialogue'], ['shot_chain', 'emotion_telling'], 30),
  reference(3, ['combat'], ['shot_chain'], 100),
  reference(4, ['dialogue'], ['summary_closure'], 100)
])

assert.deepEqual(matched.map(item => item.id), [2, 1], '必须先同时命中场景和 AI 痕迹，再按匹配度排序')
assert.equal(selectHumanRewriteReferences(assessments.get(3)!, [reference(3, ['combat'], ['shot_chain'], 100)]).length, 0)

const formatted = formatHumanRewriteReferences(matched)
assert.match(formatted, /【改写前】/)
assert.match(formatted, /【人类改写后】/)
assert.match(formatted, /删除镜头链/)
assert.doesNotMatch(formatted, /undefined/)

assert.equal(findCopiedReferencePhrase('完全不同的短句', matched), null)
assert.equal(
  findCopiedReferencePhrase('前缀“你早知道？”他没再碰桌上的杯子。后缀', matched, 12)?.referenceTitle,
  '案例2',
  '连续复制案例结果时必须被程序门禁识别'
)

console.log('人工化改写案例分类与检索测试通过')
