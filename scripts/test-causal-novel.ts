import assert from 'node:assert/strict'
import {
  CAUSAL_NOVEL_SCHEMA_VERSION,
  applyCausalChapterOutcome,
  causalEmotionGroundingRefs,
  formatCausalDecisionCard,
  validateCausalChapterEmotionContract,
  type CausalChapterOutcome,
  type CausalChapterPlan,
  type CausalNarrativeState
} from '../src/shared/causal-novel-types'

const state: CausalNarrativeState = {
  schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
  revision: 2,
  centralQuestion: '林舟会不会公开寿命交易的真相？',
  terminalConditions: ['林舟对是否公开真相作出不可逆选择'],
  immutableRules: ['寿命转移后不能自然恢复'],
  actors: [{
    name: '林舟', currentGoal: '救母亲', fear: '母亲死亡',
    knowledge: ['黑市存在'], resources: ['匿名身份'], constraint: '不能直接购买寿命'
  }, {
    name: '周岚', currentGoal: '调查黑市', fear: '证据被毁',
    knowledge: ['林舟进入过黑市'], resources: ['调查权限'], constraint: '没有直接证据'
  }],
  activePressures: [{
    id: 'pressure_black_market', source: '黑市追踪者', target: '林舟',
    condition: '追踪者正在查找截取寿命的人', escalation: '身份将在一天内暴露', urgency: 7, status: 'active'
  }],
  promises: [{
    id: 'promise_ability', question: '林舟为什么能截取寿命？', status: 'open',
    openedChapter: 1, lastAdvancedChapter: 1
  }],
  recentEventSignatures: ['林舟第一次进入黑市'],
  completed: false,
  completionReason: ''
}

const content = '追踪者摘下兜帽，说出了林舟母亲的名字。林舟终于确认，父亲曾经替黑市工作。'
const outcome: CausalChapterOutcome = {
  summary: '追踪者用母亲威胁林舟，并暴露父亲与黑市的联系。',
  eventSignature: '追踪者以母亲威胁林舟并暴露父亲身份',
  evidenceQuotes: ['追踪者摘下兜帽', '父亲曾经替黑市工作'],
  advancedPromiseIds: ['promise_ability'],
  resolvedPromiseIds: [],
  newPromises: [{ id: 'promise_father', question: '父亲在黑市中做过什么？' }],
  actorUpdates: [{
    actor: '林舟', knowledgeAdded: ['父亲曾替黑市工作'], evidence: '父亲曾经替黑市工作'
  }],
  pressureUpdates: [{
    id: 'pressure_black_market', status: 'escalated', urgency: 9,
    condition: '追踪者掌握母亲身份并直接威胁林舟', evidence: '说出了林舟母亲的名字'
  }],
  newPressures: [],
  emotionalOutcome: {
    readerEffectSummary: '读者确认威胁已经触及林舟母亲，并开始追问父亲的隐瞒。',
    triggerEvidence: '说出了林舟母亲的名字',
    choiceEvidence: '林舟终于确认',
    costEvidence: '追踪者摘下兜帽',
    residueEvidence: '父亲曾经替黑市工作',
    emotionalDebtOpened: '林舟必须重新判断父亲留下的秘密',
    emotionalDebtPaid: ''
  },
  terminalConditionMet: false,
  completionReason: ''
}

const next = applyCausalChapterOutcome(state, outcome, 3, content)
assert.equal(next.revision, 3)
assert.equal(next.promises.find(item => item.id === 'promise_ability')?.status, 'advanced')
assert.equal(next.promises.find(item => item.id === 'promise_father')?.openedChapter, 3)
assert.equal(next.activePressures[0].urgency, 9)
assert.ok(next.actors[0].knowledge.includes('父亲曾替黑市工作'))

assert.throws(
  () => applyCausalChapterOutcome(state, { ...outcome, evidenceQuotes: ['正文里不存在的句子'] }, 3, content),
  /缺少正文逐字证据/
)
assert.throws(
  () => applyCausalChapterOutcome(state, { ...outcome, advancedPromiseIds: ['unknown'] }, 3, content),
  /不存在的读者承诺/
)
assert.throws(
  () => applyCausalChapterOutcome(state, { ...outcome, emotionalOutcome: undefined as never }, 3, content),
  /缺少已经挣得的情绪结果摘要/
)

const plan: CausalChapterPlan = {
  candidates: [{
    id: 'c1', initiator: '林舟', action: '反向跟踪追踪者', opposition: '追踪者掌握母亲身份',
    cost: '暴露异常能力', irreversibleChange: '确认父亲与黑市有关',
    promiseAdvanced: 'promise_ability', newQuestion: '父亲为何替黑市工作？',
    scores: { causalNecessity: 90, promiseProgress: 90, irreversibleImpact: 85, novelty: 80, pressureEscalation: 88, total: 87 }
  }],
  selectedCandidateId: 'c1',
  decision: {
    title: '母亲的名字', pov: '林舟', initiator: '林舟', immediateWant: '摆脱追踪',
    chosenAction: '反向跟踪追踪者', opposition: '追踪者掌握母亲身份', cost: '暴露异常能力',
    openingState: '林舟被追踪', mustCover: ['确认追踪者目标', '主动反制'],
    forbiddenEvents: ['不得提前解决黑市真相'], endingState: '林舟确认父亲与黑市有关',
    continuityConstraints: ['母亲仍在医院'], characters: ['林舟', '追踪者'],
    advancedPromiseIds: ['promise_ability'], newQuestion: '父亲为何替黑市工作？'
  },
  emotionContract: {
    pov_character: '林舟', attachment_anchor: '林舟救母亲的目标正在被追踪者利用',
    value_at_stake: '母亲的安全与林舟对父亲的信任',
    reader_state_before: { label: '担忧', valence: -1, arousal: 2, agency: -1, certainty: 2 },
    trigger_event: '追踪者说出母亲的名字',
    character_appraisal: {
      perceived_meaning: '敌人已经越过身份追踪，直接触及母亲', blame_or_cause: '黑市追踪者',
      controllability: '只能反向追踪争取主动', certainty: '高度确定', value_or_norm_violated: '家人不能成为交易筹码'
    },
    character_layers: {
      felt: '恐惧与愤怒', admitted: '承认母亲正处于危险', displayed: '保持冷静继续套话',
      suppressed: '对父亲的怀疑', action_impulse: '立即反向追踪'
    },
    information_position: {
      reader_knows: '追踪者掌握母亲身份', pov_knows: '父亲可能与黑市有关',
      other_knows: '追踪者知道更多旧事', gap_type: 'reader_equal'
    },
    choice_and_cost: '林舟选择反向跟踪，并承担暴露异常能力的代价',
    private_detail_anchor: '母亲的名字', subtext_or_omission: '林舟不立刻追问父亲，只继续套取敌人信息',
    reader_state_after: { label: '警觉', valence: -1, arousal: 3, agency: 0, certainty: 1 },
    arc_role: 'build', emotional_debt_opened: '父亲与黑市的旧账', emotional_debt_paid: '',
    residue_into_next: '林舟之后的选择会被对父亲的怀疑改变',
    grounding_refs: ['actor:林舟', 'pressure:pressure_black_market', 'promise:promise_ability']
  }
}
validateCausalChapterEmotionContract(state, plan)
assert.ok(causalEmotionGroundingRefs(state).includes('actor:林舟'))
assert.throws(
  () => validateCausalChapterEmotionContract(state, {
    ...plan, emotionContract: { ...plan.emotionContract, grounding_refs: ['actor:陆野', 'promise:promise_ability'] }
  }),
  /非权威依据/
)

const card = formatCausalDecisionCard(plan)
for (const tag of ['开场状态', '必须覆盖', '禁止越界', '结尾落点', '连续性约束', '情节节点']) {
  assert.ok(card.includes(`【${tag}】`), `决策卡缺少 ${tag}`)
}
assert.ok(!card.includes('关系演化'))
assert.ok(card.includes('本章情绪执行卡'))

console.log('causal novel tests passed')
