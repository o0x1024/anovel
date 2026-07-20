import assert from 'node:assert/strict'
import {
  computeChangeRatio,
  computeDialogueRetention,
  computeNumberAnchorRetention
} from '../src/main/context/lab/aigc-rewrite-quality'
import {
  computeNarrativeChangeRatio,
  computePassedRewriteCoverage,
  findSceneRewriteProseIssues,
  requiresFullDocumentSceneRewrite
} from '../src/main/context/lab/aigc-scene-rewrite-quality'
import {
  categorizeZhuqueSentenceRisk,
  computeZhuqueRewriteRisk,
  isMeaningfulRewriteImprovement,
  isZhuqueRewriteTarget
} from '../src/main/perplexity/zhuque-rewrite-risk'
import {
  computeAigcRewriteObjective,
  isAigcRewriteObjectiveImproved
} from '../src/shared/aigc-rewrite-goal'

const source = '沈彻只剩80天。\n“别碰那颗灵核。”\n他把三阶巨蝎的情报告诉了林晚。'
const safeRewrite = '沈彻的寿数只剩80天。\n“别碰那颗灵核。”\n三阶巨蝎的情报，他先告诉了林晚。'
const dialogueChanged = safeRewrite.replace('别碰那颗灵核', '不要碰灵核')

assert.ok(computeChangeRatio(source, safeRewrite) > 0.01, '局部编辑必须能被改写幅度检测识别')
assert.equal(computeNumberAnchorRetention(source, safeRewrite), 1, '数字剧情锚点必须完整保留')
assert.equal(computeDialogueRetention(source, safeRewrite), 1, '未修改的对话必须完整保留')
assert.equal(computeDialogueRetention(source, dialogueChanged), 0, '对话内容变化必须触发拒绝门禁')

const sceneSource = '沈彻贴着墙根往前走。\n“你先走。”\n他听见脚步声，立刻停下。'
const sceneRewrite = '墙灰蹭上沈彻的肩，他没管。脚步声逼近时，他才收住步子。\n“你先走。”'
assert.ok(computeNarrativeChangeRatio(sceneSource, sceneRewrite) > 0.34, '场景重写必须真实改变非对话叙述')
assert.deepEqual(findSceneRewriteProseIssues(sceneSource, sceneRewrite), [])
assert.ok(
  findSceneRewriteProseIssues(sceneSource, `${sceneRewrite.slice(0, -1)}，`).some(item => item.includes('悬空结束')),
  '段尾逗号必须被质量门禁拒绝'
)
assert.equal(
  Math.round(computePassedRewriteCoverage(['一'.repeat(80), '二'.repeat(20)], ['一'.repeat(80)]) * 100),
  80,
  '场景块覆盖率必须按实际字符加权'
)
assert.equal(
  requiresFullDocumentSceneRewrite({ human: 0, suspected_ai: 100, ai: 0 }),
  true,
  '疑似AI占主导时也必须进入全文场景块改写，不能只处理红色句子'
)
assert.equal(
  requiresFullDocumentSceneRewrite({ human: 80, suspected_ai: 20, ai: 0 }),
  false,
  '人工特征占主导时只处理有检测证据的局部目标'
)

const fusedRisk = computeZhuqueRewriteRisk({ human: 7.7, suspected_ai: 51.2, ai: 41.1 })
assert.equal(fusedRisk, 74.4)
assert.ok(isZhuqueRewriteTarget(fusedRisk), '高三分类融合风险必须进入自动改写')
assert.ok(isMeaningfulRewriteImprovement(fusedRisk, 72.8), '有效下降必须允许进入下一轮')
assert.ok(!isMeaningfulRewriteImprovement(fusedRisk, 73.2), '微小波动不得覆盖上一版')
assert.equal(categorizeZhuqueSentenceRisk(15.8), 'human', '低风险短句不得因离散分类被标红或强制改写')
assert.equal(categorizeZhuqueSentenceRisk(50), 'suspected_ai')
assert.equal(categorizeZhuqueSentenceRisk(70), 'ai')

const beforeObjective = computeAigcRewriteObjective([
  { text: '第一句。', risk: 80 },
  { text: '第二句。', risk: 50 }
], 35)
assert.ok(isAigcRewriteObjectiveImproved(beforeObjective, computeAigcRewriteObjective([
  { text: '第一句。', risk: 60 },
  { text: '第二句。', risk: 50 }
], 35)), '非绿色句数不变时，最高风险下降仍是有效的渐进改进')
assert.ok(!isAigcRewriteObjectiveImproved(beforeObjective, computeAigcRewriteObjective([
  { text: '第一句。', risk: 70 },
  { text: '第二句。', risk: 90 }
], 35)), '目标句局部下降但全文最高风险上升时必须回滚')

console.log('AIGC 自动改写闭环质量门禁测试通过')
